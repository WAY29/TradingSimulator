const QUOTE_CURRENCIES = ['USDT', 'USDC', 'BUSD', 'USD', 'BTC', 'ETH', 'EUR', 'GBP', 'JPY']

export function baseCurrency(symbol: string) {
  const normalized = symbol.replace(/\.P$/i, '')
  return normalized.replace(/(USDT|USDC|BUSD|USD|BTC|ETH|EUR|GBP|JPY)$/i, '') || normalized
}

export function quoteCurrency(symbol: string) {
  const normalized = symbol.replace(/\.P$/i, '')
  return normalized.match(new RegExp(`(${QUOTE_CURRENCIES.join('|')})$`, 'i'))?.[1]?.toUpperCase() || ''
}

export function inferCryptoLogo(symbol: string) {
  const quote = quoteCurrency(symbol)
  return ['USDT', 'USDC', 'BUSD', 'BTC', 'ETH'].includes(quote) ? `crypto/XTVC${baseCurrency(symbol)}` : ''
}

export function symbolLogoUrl(symbol: string, logoId?: string) {
  const id = logoId || inferCryptoLogo(symbol)
  return id ? `https://s3-symbol-logo.tradingview.com/${id}--big.svg` : ''
}

export function providerLogoUrl(sourceLogoId?: string, providerId?: string) {
  const id = sourceLogoId || (providerId ? `provider/${providerId}` : '')
  return id ? `https://s3-symbol-logo.tradingview.com/${id}--big.svg` : ''
}
