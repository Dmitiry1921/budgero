/**
 * Budgets service type definitions
 * These types use PascalCase for API consistency
 */

/**
 * RtaMode - how a budget computes Ready to Assign.
 * - 'cumulative': all-time income minus all-time assignments (Budgero's original static figure).
 * - 'monthly': income through the selected month minus assignments through it, with prior-month
 *   cash overspending pulled out of Ready to Assign (YNAB-style).
 */
import type { GoalFundingSettings } from '../goals/funding.js';

export type RtaMode = 'cumulative' | 'monthly';

/**
 * Budget type - represents a budget entity
 */
export interface Budget extends Partial<GoalFundingSettings> {
  ID: number;
  SpaceID: string;
  Name: string;
  DisplayCurrency: string;
  BadgeIcon: string;
  NumberFormat: string;
  RtaMode: RtaMode;
}

/**
 * CreateBudgetRequest - API request type for creating a budget
 */
export interface CreateBudgetRequest {
  name: string;
  space_id?: string;
  display_currency: string;
  badge_icon: string;
  number_format: string;
  create_default_categories: boolean;
}
