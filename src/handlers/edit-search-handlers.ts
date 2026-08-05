import {
    EditBlockArgsSchema
} from '../tools/schemas.js';

import { handleEditBlock, handleEditBlockMultiple, handleEditLines } from '../tools/edit.js';

import { ServerResult } from '../types.js';

/**
 * Handle edit_block command
 * Uses the enhanced implementation with multiple occurrence support and fuzzy matching
 */
export { handleEditBlock, handleEditBlockMultiple, handleEditLines };