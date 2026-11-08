/**
 * Управление позицией vault в Raydium CLMM (devnet).
 *   TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/lp.ts open
 *   TS_NODE_TRANSPILE_ONLY=1 npx ts-node scripts/lp.ts status
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, getAccount, transfer,
} from "@solana/spl-token";
import {
  Raydium, PoolUtils, PoolInfoLayout, PersonalPositionLayout, TickArrayBitmapExtensionLayout, getPdaExBitmapAccount, TxVersion,
  getPdaPersonalPositionAddress, getPdaProtocolPositionAddress, getPdaTickArrayAddress,
} from "@raydium-io/raydium-sdk-v2";
import Decimal from "decimal.js";
import * as fs from "fs";
import * as path from "path";

const TOKEN_A = new PublicKey("GSvEPH7PfUUWoNGTy1bXZhbiRRkrhkMrEmcWqWk21SSX"); // TKA (токен vault)
const TOKEN_B = new PublicKey("8qARAvdUES2C9oyHPRt3f12tZZCKiN585xdXb2dq24BG"); // TKB
const POOL_ID = new PublicKey("677MS9VaSqFUGCdUW7MULfxdzpBqgx672RsLhGzn4xet");

// Диапазон цены и размер позиции
let PRICE_LOWER = Number(process.env.LOWER ?? 0.9);
let PRICE_UPPER = Number(process.env.UPPER ?? 1.1);
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
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
  if (process.env.AROUND) { PRICE_LOWER = Number(price) * 0.9; PRICE_UPPER = Number(price) * 1.1; }
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
  if (fs.existsSync(STATE_FILE)) fs.renameSync(STATE_FILE, STATE_FILE.replace(".json", "-" + Date.now() + ".json"));
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    nftMint: nft.publicKey.toBase58(), tickLower, tickUpper, startLower, startUpper,
    priceLower: PRICE_LOWER, priceUpper: PRICE_UPPER, openTx: sig,
  }, null, 2));
  await balances(c, "после открытия");
}


// ───────── Позиция: сбор комиссий, закрытие ─────────
const cu = () => ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

function loadState() {
  if (!fs.existsSync(STATE_FILE)) throw new Error("Нет scripts/position.json: сначала команда open");
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
}

async function positionCtx() {
  const c = await setup();
  const st = loadState();
  const { s, clmmProgram, price } = await readPool(c.connection);
  const nft = new PublicKey(st.nftMint);
  const accounts = {
    admin: c.wallet.publicKey,
    vaultState: c.vaultState,
    vaultTokenAccount: c.vaultTokenA,
    vaultWsolAccount: c.vaultTokenB, // в программе поле wsol, здесь TKB
    wsolMint: TOKEN_B,
    poolState: POOL_ID,
    positionNftMint: nft,
    positionNftAccount: getAssociatedTokenAddressSync(nft, c.vaultState, true, TOKEN_2022_PROGRAM_ID),
    personalPosition: getPdaPersonalPositionAddress(clmmProgram, nft).publicKey,
    protocolPosition: getPdaProtocolPositionAddress(clmmProgram, POOL_ID, st.tickLower, st.tickUpper).publicKey,
    tokenVault0: s.vaultA,
    tokenVault1: s.vaultB,
    tickArrayLower: getPdaTickArrayAddress(clmmProgram, POOL_ID, st.startLower).publicKey,
    tickArrayUpper: getPdaTickArrayAddress(clmmProgram, POOL_ID, st.startUpper).publicKey,
    vault0Mint: s.mintA,
    vault1Mint: s.mintB,
    clmmProgram,
    tokenProgram: TOKEN_PROGRAM_ID,
    tokenProgram2022: TOKEN_2022_PROGRAM_ID,
    memoProgram: MEMO_PROGRAM,
    systemProgram: SystemProgram.programId,
  };
  return { c, st, s, price, accounts, clmmProgram };
}

async function bal(c: any) {
  const a = (await getAccount(c.connection, c.vaultTokenA)).amount;
  const b = (await getAccount(c.connection, c.vaultTokenB)).amount;
  return { a: Number(a), b: Number(b) };
}

async function collect() {
  const { c, accounts, st } = await positionCtx();
  const before = await bal(c);
  const sig = await c.program.methods.collectRaydiumFees()
    .accountsPartial(accounts as any).preInstructions([cu()]).rpc();
  const after = await bal(c);
  const fees = { TKA_raw: after.a - before.a, TKB_raw: after.b - before.b };
  console.log("КОМИССИИ СОБРАНЫ:", link(sig));
  console.log(`Комиссии: TKA=${fees.TKA_raw / 1e6} (${fees.TKA_raw} raw), TKB=${fees.TKB_raw / 1e6} (${fees.TKB_raw} raw)`);
  st.fees = fees; st.collectTx = sig;
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
}

async function closePosition() {
  const { c, st, s, accounts } = await positionCtx();
  const pos = await c.connection.getAccountInfo(accounts.personalPosition);
  if (!pos) throw new Error("Позиция уже закрыта");
  const L = new Decimal(PersonalPositionLayout.decode(pos.data).liquidity.toString());

  // Ожидаемые суммы по формулам CLMM (без комиссий), минимум = 99% от них
  const sqrtP = new Decimal(s.sqrtPriceX64.toString()).div(new Decimal(2).pow(64));
  const sqrtL = new Decimal(1.0001).pow(st.tickLower / 2);
  const sqrtU = new Decimal(1.0001).pow(st.tickUpper / 2);
  let e0 = new Decimal(0), e1 = new Decimal(0);
  if (sqrtP.lte(sqrtL)) e0 = L.mul(sqrtU.minus(sqrtL)).div(sqrtL.mul(sqrtU));
  else if (sqrtP.gte(sqrtU)) e1 = L.mul(sqrtU.minus(sqrtL));
  else { e0 = L.mul(sqrtU.minus(sqrtP)).div(sqrtP.mul(sqrtU)); e1 = L.mul(sqrtP.minus(sqrtL)); }
  const min0 = e0.mul(0.99).floor().toFixed(0);
  const min1 = e1.mul(0.99).floor().toFixed(0);
  console.log(`Ожидаем вернуть (без комиссий): mintA(TKB)=${e0.floor()}, mintB(TKA)=${e1.floor()}; минимумы: ${min0}, ${min1}`);

  const before = await bal(c);
  const sig = await c.program.methods.closeRaydiumPosition(new BN(min0), new BN(min1))
    .accountsPartial(accounts as any).preInstructions([cu()]).rpc();
  const after = await bal(c);
  console.log("ПОЗИЦИЯ ЗАКРЫТА:", link(sig));
  console.log(`Вернулось: TKA=${(after.a - before.a) / 1e6}, TKB=${(after.b - before.b) / 1e6}`);
  console.log(`Баланс vault: TKA=${after.a / 1e6}, TKB=${after.b / 1e6}`);
  st.closeTx = sig; st.returned = { TKA_raw: after.a - before.a, TKB_raw: after.b - before.b };
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
}

// ───────── Обмены с другого кошелька ─────────
async function ensureTrader(c: any) {
  const keyPath = path.join(process.env.HOME!, ".config", "solana", "trader.json");
  if (!fs.existsSync(keyPath)) throw new Error("Нет ~/.config/solana/trader.json (создайте командой solana-keygen)");
  const trader = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf-8"))));
  if ((await c.connection.getBalance(trader.publicKey)) < 0.1e9) {
    await sendAndConfirmTransaction(c.connection, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: c.wallet.publicKey, toPubkey: trader.publicKey, lamports: 0.3e9 })), [c.wallet]);
    console.log("  trader: переведено 0.3 SOL");
  }
  for (const mint of [TOKEN_A, TOKEN_B]) {
    const ata = (await getOrCreateAssociatedTokenAccount(c.connection, c.wallet, mint, trader.publicKey)).address;
    if ((await getAccount(c.connection, ata)).amount < 3_000_000_000n) {
      await transfer(c.connection, c.wallet, getAssociatedTokenAddressSync(mint, c.wallet.publicKey), ata, c.wallet, 5_000_000_000);
      console.log(`  trader: переведено 5000 ${mint.toBase58().slice(0, 4)}…`);
    }
  }
  console.log("Кошелёк trader:", trader.publicKey.toBase58());
  return trader;
}

async function traderSwap(connection: Connection, trader: Keypair, inputMint: PublicKey, amountIn: number) {
  const { s, clmmProgram } = await readPool(connection);
  const raydium = await Raydium.load({
    connection, owner: trader, cluster: "devnet",
    disableFeatureCheck: true, disableLoadToken: true, blockhashCommitment: "finalized",
  });
  const data = await raydium.clmm.getPoolInfoFromRpc(POOL_ID.toBase58());
  const exAcc = await connection.getAccountInfo(getPdaExBitmapAccount(clmmProgram, POOL_ID).publicKey);
  const exBitmap = TickArrayBitmapExtensionLayout.decode(exAcc!.data);
  const tokenOut = inputMint.toBase58() === data.poolInfo.mintA.address ? data.poolInfo.mintB : data.poolInfo.mintA;
  const quote = await PoolUtils.computeAmountOutFormat({
    poolInfo: data.computePoolInfo,
    tickarrayBitmapExtension: exBitmap,
    tickArrayCache: data.tickData[POOL_ID.toBase58()],
    amountIn: new BN(amountIn),
    tokenOut: tokenOut as any,
    slippage: 0.02,
    epochInfo: await raydium.fetchEpochInfo(),
    blockTimestamp: (await connection.getBlockTime(await connection.getSlot())) ?? Math.floor(Date.now() / 1000),
  });
  const { execute } = await (raydium.clmm as any).swap({
    poolInfo: data.poolInfo,
    poolKeys: data.poolKeys,
    inputMint: inputMint.toBase58(),
    amountIn: new BN(amountIn),
    amountOutMin: quote.minAmountOut.amount.raw,
    observationId: s.observationId,
    ownerInfo: { useSOLBalance: false },
    remainingAccounts: quote.remainingAccounts,
    txVersion: TxVersion.LEGACY,
  });
  const { txId } = await execute({ sendAndConfirm: true });
  return txId as string;
}

async function swaps() {
  const c = await setup();
  const trader = await ensureTrader(c);
  console.log("Цена ДО:", (await readPool(c.connection)).price);
  for (let i = 0; i < 6; i++) {
    const aToB = i % 2 === 0; // TKA -> TKB поднимает цену, TKB -> TKA опускает
    const tx = await traderSwap(c.connection, trader, aToB ? TOKEN_A : TOKEN_B, 200_000_000);
    console.log(`swap ${i + 1}/6 (${aToB ? "TKA->TKB" : "TKB->TKA"}, 200): ${link(tx)}  цена: ${(await readPool(c.connection)).price}`);
  }
}

async function push() {
  const c = await setup();
  const st = loadState();
  const trader = await ensureTrader(c);
  for (let i = 0; i < 12; i++) {
    const price = Number((await readPool(c.connection)).price);
    console.log(`цена ${price}, верх диапазона ${st.priceUpper}`);
    if (price > st.priceUpper * 1.01) { console.log("Цена за верхней границей диапазона"); return; }
    await traderSwap(c.connection, trader, TOKEN_A, 500_000_000); // TKA -> TKB: цена растёт
  }
}

const cmds: any = { open: openPosition, status, swaps, collect, close: closePosition, push };
const cmd = process.argv[2];
(cmds[cmd] ? cmds[cmd]() : Promise.reject(new Error("команды: " + Object.keys(cmds).join(" | "))))
  .catch((e) => { console.error(e); process.exit(1); });
