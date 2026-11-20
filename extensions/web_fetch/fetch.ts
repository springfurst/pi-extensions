// SPDX-License-Identifier: MIT
// Adapted from oh-my-pi (https://omp.sh), MIT. See THIRD_PARTY_NOTICES.md.

/**
 * `web_fetch`'s entry into the shared HTTP transport. The transport itself lives
 * in `lib/web/transfer.ts`; this module keeps the pipeline's call site stable.
 */

export { transfer as loadPage } from "../../lib/web/transfer";
export type {
  TransferOptions as LoadPageOptions,
  TransferResult as LoadPageResult,
} from "../../lib/web/transfer";
