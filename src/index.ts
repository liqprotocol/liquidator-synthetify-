import * as web3 from '@solana/web3.js'
import { Connection, Account, PublicKey } from '@solana/web3.js'
import { Provider, BN } from '@project-serum/anchor'
import { Network, DEV_NET } from '@synthetify/sdk/lib/network'
import { Exchange, ExchangeState } from '@synthetify/sdk/lib/exchange'
import { ACCURACY, sleep } from '@synthetify/sdk/lib/utils'
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { isLiquidatable, parseUser, createAccountsOnAllCollaterals } from './utils'

const MINIMUM_XUSD = new BN(10).pow(new BN(ACCURACY))

const provider = Provider.local()
// @ts-expect-error
const wallet = provider.wallet.payer as Account
const connection = new Connection(web3.clusterApiUrl('devnet'), 'confirmed')
const { exchange: exchangeProgram, exchangeAuthority } = DEV_NET
const U64_MAX = new BN('18446744073709551615')

let atRisk = new Set<PublicKey>()

;(async () => {
  console.log('Initialization')
  const exchange = await Exchange.build(
    connection,
    Network.LOCAL,
    provider.wallet,
    exchangeAuthority,
    exchangeProgram
  )

  const state = await exchange.getState()
  const assetsList = await exchange.getAssetsList(state.assetsList)

  console.log('Assuring accounts on every collateral..')
  const collateralAccounts = await createAccountsOnAllCollaterals(wallet, connection, assetsList)

  const xUSDAddress = assetsList.synthetics[0].assetAddress
  const xUSDToken = new Token(connection, xUSDAddress, TOKEN_PROGRAM_ID, wallet)
  const xUSDAccount = await xUSDToken.getOrCreateAssociatedAccountInfo(wallet.publicKey)

  if (xUSDAccount.amount.lt(MINIMUM_XUSD))
    console.warn(`Account is low on xUSD (${xUSDAccount.amount.toString()})`)

  // Fetching all accounts with debt over limit
  atRisk = await getAccountsAtRisk(exchange)

  // Checking fetched accounts
  while (true) {
    const slot = new BN(await connection.getSlot())

    console.log('Starting checking accounts')
    console.time('checking time')
    for (const exchangeAccount of atRisk) {
      const { liquidationDeadline } = await exchange.getExchangeAccount(exchangeAccount)

      if (slot.lt(liquidationDeadline)) continue

      console.log('Liquidating..')

      await liquidate(exchange, exchangeAccount, state, collateralAccounts, xUSDAddress, wallet)
    }

    console.log('Finished checking..')
    console.timeEnd('checking time')
    await sleep(5000)
  }
})()

const getAccountsAtRisk = async (exchange): Promise<Set<PublicKey>> => {
  // Fetching all account associated with the exchange, and size of 510 (ExchangeAccount)
  console.log('Fetching accounts..')
  console.time('fetching time')

  const accounts = await connection.getProgramAccounts(exchangeProgram, {
    filters: [{ dataSize: 510 }]
  })

  const state: ExchangeState = await exchange.getState()
  const assetsList = await exchange.getAssetsList(state.assetsList)

  console.timeEnd('fetching time')
  console.log('Calculating..')
  console.time('calculating time')
  let atRisk = new Set<PublicKey>()
  let markedCounter = 0

  accounts.forEach(async (user) => {
    const liquidatable = isLiquidatable(state, assetsList, user)
    if (!liquidatable) return

    atRisk.add(user.pubkey)
    const deadline = parseUser(user.account).liquidationDeadline

    // Set a deadline if not already set
    if (deadline.eq(U64_MAX)) {
      await exchange.checkAccount(user.pubkey)
      markedCounter++
    }
  })

  console.log('Done scanning accounts')
  console.timeEnd('calculating time')

  console.log(`Found: ${atRisk.size} accounts at risk, and marked ${markedCounter} new`)
  return atRisk
}

const liquidate = async (
  exchange: Exchange,
  account: PublicKey,
  state: ExchangeState,
  collateralAccounts: PublicKey[],
  xUSDAddress: PublicKey,
  wallet: Account
) => {
  const exchangeAccount = await exchange.getExchangeAccount(account)
  const { collaterals, assets } = await exchange.getAssetsList(state.assetsList)

  const liquidatedEntry = exchangeAccount.collaterals[0]
  const liquidatedCollateral = collaterals[liquidatedEntry.index]
  const decimals = liquidatedCollateral.decimals
  const price = assets[liquidatedCollateral.assetIndex].price
  const { liquidationRate } = state

  const amount = new BN(1)

  await exchange.liquidate({
    exchangeAccount: account,
    signer: wallet.publicKey,
    liquidationFund: liquidatedCollateral.liquidationFund,
    amount,
    liquidatorCollateralAccount: collateralAccounts[liquidatedEntry.index],
    liquidatorUsdAccount: xUSDAddress,
    reserveAccount: liquidatedCollateral.reserveAddress,
    signers: [wallet]
  })
}
