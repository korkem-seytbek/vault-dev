import { DEVNET_PROGRAM_ID } from '@raydium-io/raydium-sdk-v2'
import { PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { initSdk, txVersion } from '../config'
import Decimal from 'decimal.js'

const TOKEN_A = 'GSvEPH7PfUUWoNGTy1bXZhbiRRkrhkMrEmcWqWk21SSX'
const TOKEN_B = '8qARAvdUES2C9oyHPRt3f12tZZCKiN585xdXb2dq24BG'

const makeToken = (address: string, symbol: string, name: string) => ({
  chainId: 101,
  address,
  programId: TOKEN_PROGRAM_ID.toBase58(),
  logoURI: '',
  symbol,
  name,
  decimals: 6,
  tags: [],
  extensions: {},
})

export const createPool = async () => {
  const raydium = await initSdk({ loadToken: false })

  const mint1 = makeToken(TOKEN_A, 'TKA', 'Token A')
  const mint2 = makeToken(TOKEN_B, 'TKB', 'Token B')

  const clmmConfigs = await raydium.api.getClmmConfigs()
  console.log('fee tier used:', clmmConfigs[0].tradeFeeRate, 'tickSpacing:', clmmConfigs[0].tickSpacing)

  const { execute, extInfo } = await raydium.clmm.createPool({
    programId: DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID,
    mint1: mint1 as any,
    mint2: mint2 as any,
    ammConfig: { ...clmmConfigs[0], id: new PublicKey(clmmConfigs[0].id), fundOwner: '', description: '' },
    initialPrice: new Decimal(1),
    txVersion,
  })

  console.log('POOL_ID:', (extInfo as any)?.address?.id?.toString?.() ?? (extInfo as any)?.address)

  const { txId } = await execute({ sendAndConfirm: true })
  console.log('clmm pool created:', `https://explorer.solana.com/tx/${txId}?cluster=devnet`)
  process.exit()
}

createPool()
