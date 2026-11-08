/**
 * Swap через vault -> Raydium CLMM (devnet).
 * Запуск:
 *   POOL_ID=<адрес пула TKA/TKB> TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/swap.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  transfer,
} from "@solana/spl-token";
import {
  Raydium,
  PoolUtils,
  PoolInfoLayout,
  SqrtPriceMath,
  getPdaExBitmapAccount,
  TickArrayBitmapExtensionLayout,
} from "@raydium-io/raydium-sdk-v2";
import Decimal from "decimal.js";
import * as fs from "fs";
import * as path from "path";

const TOKEN_A = new PublicKey("GSvEPH7PfUUWoNGTy1bXZhbiRRkrhkMrEmcWqWk21SSX"); // TKA - токен vault
const TOKEN_B = new PublicKey("8qARAvdUES2C9oyHPRt3f12tZZCKiN585xdXb2dq24BG"); // TKB
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const AMOUNT_IN = 10_000_000; // 10 TKA (6 decimals)

if (!process.env.POOL_ID) throw new Error("Укажите POOL_ID=<адрес пула>");
const POOL_ID = new PublicKey(process.env.POOL_ID);

const link = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

async function readPool(connection: Connection) {
  const acc = await connection.getAccountInfo(POOL_ID);
  if (!acc) throw new Error("Пул не найден, проверьте POOL_ID");
  const s = PoolInfoLayout.decode(acc.data);
  const sp = new Decimal(s.sqrtPriceX64.toString()).div(new Decimal(2).pow(64));
  const price = sp.pow(2).mul(new Decimal(10).pow((s.mintDecimalsA ?? 6) - (s.mintDecimalsB ?? 6)));
  return { s, price: price.toString(), clmmProgram: acc.owner };
}

async function main() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const keyPath = path.join(process.env.HOME!, ".config", "solana", "id.json");
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf-8"))));
  const provider = new AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync("target/idl/simple_vault.json", "utf-8"));
  const program = new Program(idl, provider) as any;

  // ─── Vault на токене TKA ──────────────────────────────────────────────
  const [vaultState] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), TOKEN_A.toBuffer()], program.programId);
  const [vaultTokenA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_tokens"), TOKEN_A.toBuffer()], program.programId);

  if (!(await connection.getAccountInfo(vaultState))) {
    console.log("Создаю vault на TKA...");
    const sig = await program.methods
      .initializeVault()
      .accountsPartial({ tokenMint: TOKEN_A, admin: wallet.publicKey })
      .rpc();
    console.log("  initialize_vault:", link(sig));
  }

  // ATA vault для TKB (владелец - PDA vault)
  const vaultTokenB = (await getOrCreateAssociatedTokenAccount(
    connection, wallet, TOKEN_B, vaultState, true)).address;

  // Докладываем TKA в vault, если мало
  const vaultA = await getAccount(connection, vaultTokenA);
  if (vaultA.amount < BigInt(AMOUNT_IN * 4)) {
    const myAtaA = getAssociatedTokenAddressSync(TOKEN_A, wallet.publicKey);
    await transfer(connection, wallet, myAtaA, vaultTokenA, wallet, AMOUNT_IN * 10);
    console.log("TKA переведены в vault");
  }

  // ─── Данные пула и расчёт ожидаемой суммы ─────────────────────────────
  const before = await readPool(connection);
  const { s, clmmProgram } = before;
  console.log("Цена пула ДО:", before.price);

  const raydium = await Raydium.load({
    connection, owner: wallet, cluster: "devnet",
    disableFeatureCheck: true, disableLoadToken: true, blockhashCommitment: "finalized",
  });
  const data = await raydium.clmm.getPoolInfoFromRpc(POOL_ID.toBase58());
  const inputIsA = s.mintA.equals(TOKEN_A);
  // Адреса из раскладки пула; если поле названо иначе, берём из ответа SDK
  console.log("поля пула:", Object.keys(s).join(", "));
  const keys: any = data.poolKeys;
  const toPk = (v: any) => new PublicKey(v);
  const ammConfig = (s as any).ammConfig ? toPk((s as any).ammConfig) : toPk((data.poolInfo as any).config.id);
  const observation = (s as any).observationId ? toPk((s as any).observationId) : toPk(keys.observationId);
  const poolVaultA = (s as any).vaultA ? toPk((s as any).vaultA) : toPk(keys.vault.A);
  const poolVaultB = (s as any).vaultB ? toPk((s as any).vaultB) : toPk(keys.vault.B);
  const tokenOut = inputIsA ? data.poolInfo.mintB : data.poolInfo.mintA;

  // Расширение битмапа tick-массивов и время блока нужны этой версии SDK
  let exBitmap: any = (data.computePoolInfo as any).exBitmapInfo ?? (data as any).exBitmapInfo;
  if (!exBitmap) {
    const exAcc = await connection.getAccountInfo(getPdaExBitmapAccount(clmmProgram, POOL_ID).publicKey);
    if (!exAcc) throw new Error("Не найден аккаунт bitmap extension пула");
    exBitmap = TickArrayBitmapExtensionLayout.decode(exAcc.data);
  }
  const blockTimestamp =
    (await connection.getBlockTime(await connection.getSlot())) ?? Math.floor(Date.now() / 1000);

  const quote = await PoolUtils.computeAmountOutFormat({
    tickarrayBitmapExtension: exBitmap,
    blockTimestamp,
    poolInfo: data.computePoolInfo,
    tickArrayCache: data.tickData[POOL_ID.toBase58()],
    amountIn: new BN(AMOUNT_IN),
    tokenOut: tokenOut as any,
    slippage: 0.01,
    epochInfo: await raydium.fetchEpochInfo(),
  });
  const expectedOut: BN = quote.amountOut.amount.raw;
  const minOut: BN = quote.minAmountOut.amount.raw; // ожидаемое минус 1%
  console.log(`Ожидаем: ${expectedOut.toString()}, минимум (-1%): ${minOut.toString()}`);

  const remaining = [
    getPdaExBitmapAccount(clmmProgram, POOL_ID).publicKey,
    ...quote.remainingAccounts,
  ].map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));

  const buildSwap = (minimumOut: BN) =>
    program.methods
      .swapViaRaydium(new BN(AMOUNT_IN), minimumOut, new BN(0))
      .accountsPartial({
        admin: wallet.publicKey,
        vaultState,
        inputTokenAccount: vaultTokenA,   // vault всегда отдаёт TKA
        outputTokenAccount: vaultTokenB,  // и получает TKB
        ammConfig,
        poolState: POOL_ID,
        observationState: observation,
        inputVault: inputIsA ? poolVaultA : poolVaultB,
        outputVault: inputIsA ? poolVaultB : poolVaultA,
        inputVaultMint: inputIsA ? s.mintA : s.mintB,
        outputVaultMint: inputIsA ? s.mintB : s.mintA,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        memoProgram: MEMO_PROGRAM,
        clmmProgram,
      } as any)
      .remainingAccounts(remaining)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })]);

  // ─── 1. Успешный swap ─────────────────────────────────────────────────
  const okSig = await buildSwap(minOut).rpc();
  console.log("УСПЕШНЫЙ swap:", link(okSig));
  const after = await readPool(connection);
  console.log("Цена пула ПОСЛЕ:", after.price);

  // ─── 2. Отклонённый swap: минимум завышен в 1.5 раза ──────────────────
  const tx = await buildSwap(expectedOut.mul(new BN(150)).div(new BN(100))).transaction();
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(wallet);
  const failSig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await connection.confirmTransaction(failSig, "confirmed");
  const st = await connection.getSignatureStatus(failSig, { searchTransactionHistory: true });
  console.log("ОТКЛОНЁННЫЙ swap (slippage):", link(failSig));
  console.log("  статус:", JSON.stringify(st.value?.err));

  console.log(`\nЦена: ${before.price} -> ${after.price}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
