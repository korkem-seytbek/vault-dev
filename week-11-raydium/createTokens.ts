import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { owner, connection } from "../config";

(async () => {
  for (const name of ["A", "B"]) {
    const mint = await createMint(connection, owner, owner.publicKey, null, 6);
    const ata = await getOrCreateAssociatedTokenAccount(connection, owner, mint, owner.publicKey);
    await mintTo(connection, owner, mint, ata.address, owner, 1_000_000 * 10 ** 6);
    console.log(`TOKEN_${name}:`, mint.toBase58());
  }
  process.exit();
})();
