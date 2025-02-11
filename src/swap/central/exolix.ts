import { lt } from 'biggystring'
import {
  asEither,
  asMaybe,
  asNull,
  asNumber,
  asObject,
  asOptional,
  asString
} from 'cleaners'
import {
  EdgeCorePluginOptions,
  EdgeFetchResponse,
  EdgeMemo,
  EdgeSpendInfo,
  EdgeSwapInfo,
  EdgeSwapPlugin,
  EdgeSwapQuote,
  EdgeSwapRequest,
  SwapBelowLimitError,
  SwapCurrencyError
} from 'edge-core-js/types'

import {
  checkInvalidCodes,
  checkWhitelistedMainnetCodes,
  getCodesWithTranscription,
  getMaxSwappable,
  InvalidCurrencyCodes,
  makeSwapPluginQuote,
  SwapOrder
} from '../../util/swapHelpers'
import { convertRequest, getAddress, memoType } from '../../util/utils'
import { EdgeSwapRequestPlugin } from '../types'

const pluginId = 'exolix'

const swapInfo: EdgeSwapInfo = {
  pluginId,
  isDex: false,
  displayName: 'Exolix',
  supportEmail: 'support@exolix.com'
}

const asInitOptions = asObject({
  apiKey: asString
})

const INVALID_CURRENCY_CODES: InvalidCurrencyCodes = {
  from: {},
  to: {
    zcash: ['ZEC']
  }
}

// See https://exolix.com/currencies for list of supported currencies
const MAINNET_CODE_TRANSCRIPTION = {
  algorand: 'ALGO',
  arbitrum: 'ARBITRUM',
  avalanche: 'AVAXC',
  // axelar:
  // base:
  // binance:
  binancesmartchain: 'BSC',
  bitcoin: 'BTC',
  bitcoincash: 'BCH',
  // bitcoingold:
  // bitcoinsv:
  cardano: 'ADA',
  celo: 'CELO',
  // coreum:
  cosmoshub: 'ATOM',
  dash: 'DASH',
  digibyte: 'DGB',
  dogecoin: 'DOGE',
  // eboost:
  eos: 'EOS',
  ethereum: 'ETH',
  ethereumclassic: 'ETC',
  // ethereumpow:
  fantom: 'FTM',
  // feathercoin:
  filecoin: 'FIL',
  // filecoinfevm:
  // fio:
  // groestlcoin:
  hedera: 'HBAR',
  // liberland:
  litecoin: 'LTC',
  monero: 'XMR',
  optimism: 'OPTIMISM',
  osmosis: 'OSMO',
  // piratechain:
  polkadot: 'DOT',
  // polygon:
  // pulsechain:
  qtum: 'QTUM',
  ravencoin: 'RVN',
  ripple: 'XRP',
  // rsk:
  // smartcash:
  solana: 'SOL',
  stellar: 'XLM',
  telos: 'TELOS',
  tezos: 'XTZ',
  thorchainrune: 'RUNE',
  tron: 'TRX',
  // ufo:
  // vertcoin:
  // wax:
  zcash: 'ZEC'
  // zcoin:
  // zksync:
}

const orderUri = 'https://exolix.com/transaction/'
const uri = 'https://exolix.com/api/v2/'

const expirationMs = 1000 * 60

const asRateResponse = asObject({
  minAmount: asNumber,
  withdrawMin: asOptional(asNumber, 0),
  fromAmount: asNumber,
  toAmount: asNumber,
  message: asEither(asString, asNull)
})

const asQuoteInfo = asObject({
  id: asString,
  amount: asNumber,
  amountTo: asNumber,
  depositAddress: asString,
  depositExtraId: asOptional(asString)
})

export function makeExolixPlugin(opts: EdgeCorePluginOptions): EdgeSwapPlugin {
  const { io, log } = opts
  const { fetchCors = io.fetch } = io
  const { apiKey } = asInitOptions(opts.initOptions)

  const getFixedQuote = async (
    request: EdgeSwapRequestPlugin,
    _userSettings: Object | undefined
  ): Promise<SwapOrder> => {
    async function call(
      method: 'GET' | 'POST',
      route: string,
      params: any
    ): Promise<Object> {
      const headers: { [header: string]: string } = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `${apiKey}`
      }

      let response: EdgeFetchResponse

      if (method === 'POST') {
        const body = JSON.stringify(params)
        response = await fetchCors(uri + route, {
          method,
          headers,
          body
        })
      } else {
        const url = `${uri}${route}?${new URLSearchParams(params).toString()}`
        response = await fetchCors(url, {
          method,
          headers
        })
      }

      if (!response.ok) {
        if (response.status === 422) {
          // Exolix inconsistently returns a !ok response for a 'from' quote
          // under minimum amount, while the status is OK for a 'to' quote under
          // minimum amount.
          // Handle this inconsistency and ensure parse the proper under min error
          // and we don't exit early with the wrong 'unsupported' error message.
          const resJson = await response.json()
          const maybeMinError = asMaybe(asRateResponse)(resJson)
          if (maybeMinError != null) {
            return resJson
          }

          log.warn(`Error retrieving Exolix quote: ${String(resJson)}`)
          throw new SwapCurrencyError(swapInfo, request)
        }
        throw new Error(`Exolix returned error code ${response.status}`)
      }

      return await response.json()
    }

    const [fromAddress, toAddress] = await Promise.all([
      getAddress(request.fromWallet),
      getAddress(request.toWallet)
    ])

    const exchangeQuoteAmount =
      request.quoteFor === 'from'
        ? await request.fromWallet.nativeToDenomination(
            request.nativeAmount,
            request.fromCurrencyCode
          )
        : await request.toWallet.nativeToDenomination(
            request.nativeAmount,
            request.toCurrencyCode
          )

    const quoteAmount = parseFloat(exchangeQuoteAmount)

    const {
      fromCurrencyCode,
      toCurrencyCode,
      fromMainnetCode,
      toMainnetCode
    } = getCodesWithTranscription(request, MAINNET_CODE_TRANSCRIPTION)

    const quoteParams: Record<string, any> = {
      coinFrom: fromCurrencyCode,
      coinFromNetwork: fromMainnetCode,
      coinTo: toCurrencyCode,
      coinToNetwork: toMainnetCode,
      amount: quoteAmount,
      rateType: 'fixed'
    }

    // Set the withdrawal amount if we are quoting for the toCurrencyCode
    if (request.quoteFor === 'to') {
      quoteParams.withdrawalAmount = quoteAmount
    }

    // Get Rate
    const rateResponse = asRateResponse(await call('GET', 'rate', quoteParams))

    // Check rate minimum:
    if (request.quoteFor === 'from') {
      const nativeMin = await request.fromWallet.denominationToNative(
        rateResponse.minAmount.toString(),
        request.fromCurrencyCode
      )

      if (lt(request.nativeAmount, nativeMin)) {
        throw new SwapBelowLimitError(swapInfo, nativeMin, 'from')
      }
    } else {
      const nativeMin = await request.toWallet.denominationToNative(
        rateResponse.withdrawMin.toString(),
        request.toCurrencyCode
      )

      if (lt(request.nativeAmount, nativeMin)) {
        throw new SwapBelowLimitError(swapInfo, nativeMin, 'to')
      }
    }

    // Make the transaction:
    const exchangeParams: Record<string, any> = {
      coinFrom: quoteParams.coinFrom,
      networkFrom: quoteParams.coinFromNetwork,
      coinTo: quoteParams.coinTo,
      networkTo: quoteParams.coinToNetwork,
      amount: quoteAmount,
      withdrawalAddress: toAddress,
      withdrawalExtraId: '',
      refundAddress: fromAddress,
      refundExtraId: '',
      rateType: 'fixed'
    }

    // Set the withdrawal amount if we are quoting for the toCurrencyCode
    if (request.quoteFor === 'to') {
      exchangeParams.withdrawalAmount = quoteAmount
    }

    const callJson = await call('POST', 'transactions', exchangeParams)
    const quoteInfo = asQuoteInfo(callJson)

    const fromNativeAmount = await request.fromWallet.denominationToNative(
      quoteInfo.amount.toString(),
      request.fromCurrencyCode
    )

    const toNativeAmount = await request.toWallet.denominationToNative(
      quoteInfo.amountTo.toString(),
      request.toCurrencyCode
    )

    const memos: EdgeMemo[] =
      quoteInfo.depositExtraId == null
        ? []
        : [
            {
              type: memoType(request.fromWallet.currencyInfo.pluginId),
              value: quoteInfo.depositExtraId
            }
          ]

    const spendInfo: EdgeSpendInfo = {
      tokenId: request.fromTokenId,
      spendTargets: [
        {
          nativeAmount: fromNativeAmount,
          publicAddress: quoteInfo.depositAddress
        }
      ],
      memos,
      networkFeeOption:
        request.fromCurrencyCode.toUpperCase() === 'BTC' ? 'high' : 'standard',
      assetAction: {
        assetActionType: 'swap'
      },
      savedAction: {
        actionType: 'swap',
        swapInfo,
        orderId: quoteInfo.id,
        orderUri: orderUri + quoteInfo.id,
        isEstimate: false,
        toAsset: {
          pluginId: request.toWallet.currencyInfo.pluginId,
          tokenId: request.toTokenId,
          nativeAmount: toNativeAmount
        },
        fromAsset: {
          pluginId: request.fromWallet.currencyInfo.pluginId,
          tokenId: request.fromTokenId,
          nativeAmount: fromNativeAmount
        },
        payoutAddress: toAddress,
        payoutWalletId: request.toWallet.id,
        refundAddress: fromAddress
      }
    }

    return {
      request,
      spendInfo,
      swapInfo,
      fromNativeAmount,
      expirationDate: new Date(Date.now() + expirationMs)
    }
  }

  const out: EdgeSwapPlugin = {
    swapInfo,
    async fetchSwapQuote(
      req: EdgeSwapRequest,
      userSettings: Object | undefined
    ): Promise<EdgeSwapQuote> {
      const request = convertRequest(req)

      checkInvalidCodes(INVALID_CURRENCY_CODES, request, swapInfo)
      checkWhitelistedMainnetCodes(
        MAINNET_CODE_TRANSCRIPTION,
        request,
        swapInfo
      )

      const newRequest = await getMaxSwappable(
        getFixedQuote,
        request,
        userSettings
      )
      const fixedOrder = await getFixedQuote(newRequest, userSettings)
      const fixedResult = await makeSwapPluginQuote(fixedOrder)

      return fixedResult
    }
  }

  return out
}
