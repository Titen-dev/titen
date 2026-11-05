// All external data sources in one place (features take this object so tests can swap it).
export { searchNews, topStories } from './googleNews.js';
export { trendingSearches } from './googleTrends.js';
export { hnTopStories } from './hackerNews.js';
export { githubTrending } from './githubTrending.js';
export { domainAge } from './rdap.js';
export { readPage } from './fetchPage.js';
export { webSearch } from './webSearch.js';
