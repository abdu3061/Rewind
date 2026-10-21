/** Planned permission gates. No permission requests are made by this starter. */
export interface BrowserConsent {
  collectionEnabled: boolean;
  articleExtractionEnabled: boolean;
  allowedArticleHosts: readonly string[];
}
