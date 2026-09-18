/**
 * Web access, and the honest limit of it.
 *
 * "Search Google for X" needs no retrieval at all: JARVIS builds a search URL
 * and opens it in the browser (searchUrl below). "Research the latest X and
 * summarise it" is different - it needs real, current documents, and a local
 * model has no live knowledge. Letting granite answer from memory would be
 * inventing current events, so this build does not pretend: research_web opens
 * the search and says it cannot read live results yet.
 *
 * WebSearchProvider - the extension point for real retrieval later:
 *
 *   {
 *     id: 'searxng' | 'brave-api' | ...,
 *     available: true,
 *     async search(query, { signal }) -> [{ title, url, snippet }]
 *   }
 *
 * A provider plugged in here would feed its results to the brain as context
 * for a summary. None is configured, and none is required.
 */

export const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
}

export function searchUrl(query, engine = 'google') {
  return (SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.google) + encodeURIComponent(String(query).trim())
}

/** The default: no live retrieval. */
export const noWebSearch = {
  id: 'none',
  available: false,
  async search() {
    throw new Error('no web search provider is configured')
  },
}
