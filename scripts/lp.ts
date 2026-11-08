/**
 * Управление позицией vault в Raydium CLMM (devnet).
 *   TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/lp.ts open
 *   TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/lp.ts status
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, getAccount, transfer,
} from "@solana/spl-token";
import {
  Raydium, PoolUtils, PoolInfoLayout,
  getPdaPersonalPositionAddress, getPdaProtocolPositionAddress, getPdaTickArrayAddress,
} from "@raydium-io/raydium-sdk-v2";
import Decimal from "decimal.js";
import * as fs from "fs";
import * as path from "path";

const TOKEN_A = new PublicKey("GSvEPH7PfUUWoNGTy1bXZhbiRRkrhkMrEmcWqWk21SSX"); // TKA (токен vault)
const TOKEN_B = new PublicKey("8qARAvdUES2C9oyHPRt3f12tZZCKiN585xdXb2dq24BG"); // TKB
const POOL_ID = new PublicKey("677MS9VaSqFUGCdUW7MULfxdzpBqgx672RsLhGzn4xet");

// Диапазон цены и размер позиции
const PRICE_LOWER = 0.9;
const PRICE_UPPER = 1.1;
const BASE_AMOUNT = 5_000_000; // 5 TKA (6 decimals), TKB подтянется по формуле


// Один tick-массив Raydium CLMM содержит 60 тиков (по tickSpacing каждый)
const tickArrayStart = (tick: number, spacing: number) => {
  const span = 60 * spacing;
  return Math.floor(tick / span) * span;
};

const STATE_FILE = path.join(__dirname, "position.json");
const link = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

async function setup() {
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const keyPath = path.join(process.env.HOME!, ".config", "solana", "id.json");
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf-8"))));
  const provider = new AnchorProvider(connection, new anchor.Wallet(wallet), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/simple_vault.json"), "utf-8"));
  const program = new Program(idl, provider) as any;
  const [vaultState] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), TOKEN_A.toBuffer()], program.programId);
  const [vaultTokenA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_tokens"), TOKEN_A.toBuffer()], program.programId);
  const vaultTokenB = (await getOrCreateAssociatedTokenAccount(
    connection, wallet, TOKEN_B, vaultState, true)).address;
  return { connection, wallet, program, vaultState, vaultTokenA, vaultTokenB };
}

async function readPool(connection: Connection) {
  const acc = await connection.getAccountInfo(POOL_ID);
  if (!acc) throw new Error("Пул не найден");
  const s = PoolInfoLayout.decode(acc.data);
  const sp = new Decimal(s.sqrtPriceX64.toString()).div(new Decimal(2).pow(64));
  const price = sp.pow(2).mul(new Decimal(10).pow((s.mintDecimalsA ?? 6) - (s.mintDecimalsB ?? 6)));
  return { s, price: price.toString(), clmmProgram: acc.owner };
}

async function balances(c: any, label: string) {
  const a = (await getAccount(c.connection, c.vaultTokenA)).amount;
  const b = (await getAccount(c.connection, c.vaultTokenB)).amount;
  console.log(`[${label}] vault: TKA=${Number(a) / 1e6}, TKB=${Number(b) / 1e6}`);
}

async function status() {
  const c = await setup();
  const p = await readPool(c.connection);
  console.log("Цена пула:", p.price, " tickCurrent:", p.s.tickCurrent, " liquidity:", p.s.liquidity.toString());
  await balances(c, "сейчас");
  if (fs.existsSync(STATE_FILE)) console.log("Позиция:", fs.readFileSync(STATE_FILE, "utf-8"));
}

async function openPosition() {
  const c = await setup();
  const { s, clmmProgram, price } = await readPool(c.connection);
  console.log("Цена пула:", price);
  await balances(c, "до открытия");

  // ─── Диапазон тиков из цены ───────────────────────────────────────────
  const ts = s.tickSpacing;
  const tickOf = (x: number) => Math.log(x) / Math.log(1.0001); // у обоих токенов 6 decimals
  const tickLower = Math.floor(tickOf(PRICE_LOWER) / ts) * ts;
  const tickUpper = Math.ceil(tickOf(PRICE_UPPER) / ts) * ts;
  const startLower = tickArrayStart(tickLower, ts);
  const startUpper = tickArrayStart(tickUpper, ts);
  console.log(`Диапазон цены ${PRICE_LOWER}-${PRICE_UPPER}, тики ${tickLower}..${tickUpper}, tickSpacing=${ts}`);

  // ─── Ликвидность и максимумы токенов ──────────────────────────────────
  const raydium = await Raydium.load({
    connection: c.connection, owner: c.wallet, cluster: "devnet",
    disableFeatureCheck: true, disableLoadToken: true, blockhashCommitment: "finalized",
  });
  const { poolInfo } = await raydium.clmm.getPoolInfoFromRpc(POOL_ID.toBase58());
  const aIsMintA = s.mintA.equals(TOKEN_A);
  const res = await PoolUtils.getLiquidityAmountOutFromAmountIn({
    poolInfo,
    slippage: 0.01,
    inputA: aIsMintA, // база - TKA
    tickUpper, tickLower,
    amount: new BN(BASE_AMOUNT),
    add: true,
    epochInfo: await c.connection.getEpochInfo(),
    amountHasFee: false,
  });
  const liquidity = new BN(res.liquidity.toString());
  // В этой версии SDK запас slippage идёт в минус, поэтому берём +3% сверху сами.
  // Raydium заберёт только нужную сумму, максимум - потолок.
  const withMargin = (x: any) => new BN(x.amount.toString()).mul(new BN(103)).div(new BN(100));
  const amount0Max = withMargin(res.amountSlippageA); // mintA пула
  const amount1Max = withMargin(res.amountSlippageB); // mintB пула
  console.log(`Ликвидность: ${liquidity}, amount0Max: ${amount0Max}, amount1Max: ${amount1Max}`);

  // ─── Дополнить vault токенами, если не хватает ────────────────────────
  const needA = aIsMintA ? amount0Max : amount1Max;
  const needB = aIsMintA ? amount1Max : amount0Max;
  for (const [mint, acct, need] of [
    [TOKEN_A, c.vaultTokenA, needA], [TOKEN_B, c.vaultTokenB, needB],
  ] as [PublicKey, PublicKey, BN][]) {
    const have = (await getAccount(c.connection, acct)).amount;
    const want = BigInt(need.toString()) + 1_000_000n;
    if (have < want) {
      const src = getAssociatedTokenAddressSync(mint, c.wallet.publicKey);
      await transfer(c.connection, c.wallet, src, acct, c.wallet, want - have);
      console.log(`  доложено в vault: ${(want - have).toString()} (${mint.toBase58().slice(0, 4)}…)`);
    }
  }

  // ─── Адреса Raydium ───────────────────────────────────────────────────
  const nft = Keypair.generate();
  const positionNftAccount = getAssociatedTokenAddressSync(
    nft.publicKey, c.vaultState, true, TOKEN_2022_PROGRAM_ID);
  const personalPosition = getPdaPersonalPositionAddress(clmmProgram, nft.publicKey).publicKey;
  const protocolPosition = getPdaProtocolPositionAddress(clmmProgram, POOL_ID, tickLower, tickUpper).publicKey;
  const tickArrayLower = getPdaTickArrayAddress(clmmProgram, POOL_ID, startLower).publicKey;
  const tickArrayUpper = getPdaTickArrayAddress(clmmProgram, POOL_ID, startUpper).publicKey;

  const sig = await c.program.methods
    .openRaydiumPosition(tickLower, tickUpper, startLower, startUpper, liquidity, amount0Max, amount1Max)
    .accountsPartial({
      admin: c.wallet.publicKey,
      vaultState: c.vaultState,
      vaultTokenAccount: c.vaultTokenA,
      vaultWsolAccount: c.vaultTokenB, // в программе поле названо wsol, здесь это TKB
      wsolMint: TOKEN_B,
      poolState: POOL_ID,
      positionNftMint: nft.publicKey,
      positionNftAccount,
      personalPosition,
      protocolPosition,
      tickArrayLower,
      tickArrayUpper,
      tokenVault0: s.vaultA,
      tokenVault1: s.vaultB,
      vault0Mint: s.mintA,
      vault1Mint: s.mintB,
      tickArrayBitmap: PublicKey.findProgramAddressSync(
        [Buffer.from("pool_tick_array_bitmap_extension"), POOL_ID.toBuffer()], clmmProgram)[0],
      clmmProgram,
      rent: SYSVAR_RENT_PUBKEY,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    } as any)
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
    .signers([c.wallet, nft])
    .rpc();

  console.log("ПОЗИЦИЯ ОТКРЫТА:", link(sig));
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    nftMint: nft.publicKey.toBase58(), tickLower, tickUpper, startLower, startUpper,
    priceLower: PRICE_LOWER, priceUpper: PRICE_UPPER, openTx: sig,
  }, null, 2));
  await balances(c, "после открытия");
}

const cmd = process.argv[2];
(cmd === "open" ? openPosition() : cmd === "status" ? status() : Promise.reject(new Error("команда: open | status")))
  .catch((e) => { console.error(e); process.exit(1); });
