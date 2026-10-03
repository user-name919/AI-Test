interface BrowserObserverOptions {
  selector: string
  maxElements: number
  maxTextLength: number
  maxTableRows: number
}

export function observePageInBrowser(options: BrowserObserverOptions): unknown
