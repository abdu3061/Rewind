import type { Result } from '@rewind/contracts';

/** Future Readability implementation runs only after explicit per-site permission. */
export interface ArticleExtractor {
  extract(document: Document): Result<{ title: string; text: string }>;
}
