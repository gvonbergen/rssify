# Targeted article deletion plan

- Add a dedicated `rssify delete-article <site> <hash>` command so legacy `remove <site> [section] [--purge]` remains unambiguous and unchanged. Use the exact 40-character lowercase SHA-1 already exposed by listing links and article URLs.
- Validate the site, full hash, exact database row, and stored artifact paths before mutation.
- Rename only the selected article's cleaned, raw, metadata, and LLM files to temporary tombstones; delete its database row and cascading section memberships transactionally; restore staged files if the database step fails; then unlink the tombstones. Missing files are harmless, and the site directory is never recursively removed.
- Cover database/feed/index/article-route removal, sibling and site/section preservation, artifact isolation, malformed/traversal/not-found safety, partial filesystem absence, and legacy CLI grammar. Document identifier discovery in CLI help, README, and FUNCTIONS.
