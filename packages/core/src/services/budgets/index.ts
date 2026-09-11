import { DatabaseAdapter } from '../../database/interface.js';
import { run } from '../../database/sql.js';
import { Budget, CreateBudgetRequest, RtaMode } from './types.js';
import { ValidationError, NotFoundError } from '../../types/index.js';
import { isCryptoCurrency } from '../../currencies/index.js';
import { BudgetQueries } from './queries.js';
import { CurrencyService } from '../currency/index.js';
import { CategoryService } from '../categories/index.js';
import {
  getGoalFundingSettings,
  isValidFundingPriority,
  type GoalFundingSettings,
  type FundingPriorityUpdate,
} from '../goals/funding.js';

/**
 * BudgetService - Port of Go budgets service
 * Handles budget CRUD operations and default category creation
 *
 * All methods match the Go implementation in internal/budgets/budgets.go
 */
export class BudgetService {
  private queries: BudgetQueries;

  private currencyService: CurrencyService;

  constructor(private db: DatabaseAdapter) {
    this.queries = new BudgetQueries(db);
    this.currencyService = new CurrencyService(db);
  }

  /**
   * InsertBudget - Creates a new budget with default categories
   *
   * Key differences from Go:
   * - Returns Promise<number> instead of (int64, error)
   */
  private async insertBudget(
    spaceId: string,
    name: string,
    displayCurrency: string,
    badgeIcon: string,
    numberFormat: string,
    createDefaultCategories = true
  ): Promise<number> {
    if (!name || name === '') {
      throw new Error('budget name cannot be empty');
    }

    const budgetId = this.queries.insertBudget(
      spaceId,
      name,
      displayCurrency,
      badgeIcon,
      numberFormat
    );

    // System categories are always created — many flows depend on them existing.
    // The flag only controls the starter categories (Frequent, Goals, ...).
    if (createDefaultCategories) {
      await this.insertDefaultCategories(budgetId);
    } else {
      await this.insertSystemCategories(budgetId);
    }

    return budgetId;
  }

  /**
   * GetAllBudgets - Retrieves all budgets
   */
  getAllBudgets(spaceId?: string): Budget[] {
    return this.queries.getAllBudgets(spaceId);
  }

  /**
   * UpdateBudgetName - Updates budget name
   */
  updateBudgetName(id: number, name: string): void {
    this.queries.updateBudgetName(id, name);
  }

  /**
   * UpdateBudgetNumberFormat - Updates budget number format
   */
  updateBudgetNumberFormat(id: number, format: string): void {
    this.queries.updateBudgetNumberFormat(id, format);
  }

  /**
   * UpdateBudgetCurrency - Updates budget display currency
   * Handles currency change by clearing all converted amounts
   */
  async updateBudgetCurrency(id: number, currency: string): Promise<void> {
    if (isCryptoCurrency(currency)) {
      throw new ValidationError(
        'The budget display currency must be a fiat currency; crypto is supported on accounts',
        'display_currency'
      );
    }
    // Get the current budget to check old currency
    const budget = this.queries.getBudget(id);
    if (!budget) {
      throw new NotFoundError('Budget', id);
    }

    const oldCurrency = budget.DisplayCurrency;

    this.queries.updateBudgetCurrency(id, currency);

    if (oldCurrency !== currency) {
      await this.currencyService.handleBudgetCurrencyChange(id, currency, oldCurrency);
    }
  }

  /**
   * UpdateBudgetIcon - Updates budget icon
   */
  updateBudgetIcon(id: number, icon: string): void {
    this.queries.updateBudgetIcon(id, icon);
  }

  /**
   * GetRtaMode - Reads a budget's Ready to Assign calculation mode.
   */
  getRtaMode(id: number): RtaMode {
    return this.queries.getRtaMode(id);
  }

  /**
   * UpdateBudgetRtaMode - Sets a budget's Ready to Assign calculation mode.
   */
  updateRtaMode(id: number, mode: RtaMode): void {
    this.queries.updateRtaMode(id, mode);
  }

  /** Settings and any five-level conversion are a single reversible transaction. */
  updateGoalFundingSettings(
    id: number,
    patch: Partial<GoalFundingSettings>,
    restorePriorities: FundingPriorityUpdate[] = []
  ): void {
    const current = getGoalFundingSettings(this.getBudget(id));
    const next = { ...current, ...patch };
    if (
      !['five-levels', 'numeric'].includes(next.CategoryPriorityMode) ||
      !['proportional-shortfall', 'equal-completion'].includes(next.GoalFundingDistribution) ||
      typeof next.ShowCategoryPriorities !== 'boolean'
    ) {
      throw new ValidationError('Invalid goal funding settings');
    }
    this.db.transaction(() => {
      const categories = new CategoryService(this.db);
      for (const update of restorePriorities) {
        if (
          categories.getCategory(update.categoryId).BudgetID !== id ||
          !isValidFundingPriority(update.priority, next.CategoryPriorityMode)
        ) {
          throw new ValidationError('Invalid category priority restore');
        }
      }
      run(
        this.db,
        `UPDATE budgets SET CategoryPriorityMode = ?, GoalFundingDistribution = ?, ShowCategoryPriorities = ? WHERE ID = ?`,
        next.CategoryPriorityMode,
        next.GoalFundingDistribution,
        next.ShowCategoryPriorities ? 1 : 0,
        id
      );
      if (next.CategoryPriorityMode === 'five-levels') {
        run(
          this.db,
          'UPDATE categories SET FundingPriority = 5 WHERE BudgetID = ? AND FundingPriority > 5',
          id
        );
      }
      for (const update of restorePriorities) {
        run(
          this.db,
          'UPDATE categories SET FundingPriority = ? WHERE ID = ?',
          update.priority,
          update.categoryId
        );
      }
    });
  }

  /**
   * DeleteBudget - Deletes a budget
   */
  deleteBudget(id: number): void {
    this.queries.deleteBudget(id);
  }

  /**
   * InsertDefaultCategories - Inserts default category groups and categories for a budget
   *
   * This exactly replicates the Go logic with the same default groups and categories
   */
  async insertDefaultCategories(budgetId: number): Promise<void> {
    // First create essential system categories that many parts of the app expect
    await this.insertSystemCategories(budgetId);

    // Define default groups and their associated categories - EXACT MATCH with Go
    const defaultGroups: Record<string, string[]> = {
      Frequent: ['Groceries', 'Eating Out', 'Transportation'],
      'Non-Monthly': ['Auto Maintenance', 'Gifts', 'Home Improvement'],
      Goals: ['Retirement', 'Vacation'],
      'Quality of Life': ['Health & Wellness', 'Entertainment'],
    };

    this.insertCategoryGroups(budgetId, defaultGroups);
  }

  /**
   * InsertSystemCategories - Inserts the system category groups (Income, Uncategorized,
   * Transfers) that the app expects every budget to have. Always run on budget creation,
   * regardless of whether the user opted out of the starter categories.
   */
  async insertSystemCategories(budgetId: number): Promise<void> {
    const systemGroups: Record<string, string[]> = {
      Income: ['Income'],
      Uncategorized: ['Uncategorized'],
      Transfers: ['Transfers'],
    };

    this.insertCategoryGroups(budgetId, systemGroups);
  }

  private insertCategoryGroups(budgetId: number, groups: Record<string, string[]>): void {
    for (const [groupName, categories] of Object.entries(groups)) {
      try {
        const groupId = this.insertCategoryGroup(groupName, '', budgetId);

        for (const catName of categories) {
          this.insertCategory(catName, '', groupId, budgetId);
        }
      } catch (error) {
        throw new Error(
          `failed to insert category group "${groupName}": ${error instanceof Error ? error.message : 'unknown error'}`
        );
      }
    }
  }

  // Helper methods for category operations (used by insertDefaultCategories)
  private insertCategoryGroup(name: string, note: string, budgetId: number): number {
    const result = run(
      this.db,
      `
      INSERT INTO category_groups (Name, Note, BudgetID)
      VALUES (?1, ?2, ?3)
    `,
      name,
      note,
      budgetId
    );
    return Number(result.lastInsertRowid);
  }

  private insertCategory(
    name: string,
    note: string,
    categoryGroupId: number,
    budgetId: number
  ): number {
    const result = run(
      this.db,
      `
      INSERT INTO categories (Name, Note, CategoryGroupID, BudgetID)
      VALUES (?1, ?2, ?3, ?4)
    `,
      name,
      note,
      categoryGroupId,
      budgetId
    );
    return Number(result.lastInsertRowid);
  }

  // === Additional methods from the existing TypeScript implementation ===
  // These are NOT in the Go service but are kept for backward compatibility

  /**
   * Create a new budget with validation
   * This wraps insertBudget with additional validation
   */
  async createBudget(request: CreateBudgetRequest): Promise<number> {
    const {
      name,
      space_id,
      display_currency,
      badge_icon,
      number_format,
      create_default_categories = true,
    } = request;

    if (!name || name.trim() === '') {
      throw new ValidationError('Budget name cannot be empty', 'name');
    }

    if (!display_currency || display_currency.trim() === '') {
      throw new ValidationError('Display currency cannot be empty', 'display_currency');
    }
    if (isCryptoCurrency(display_currency)) {
      throw new ValidationError(
        'The budget display currency must be a fiat currency; crypto is supported on accounts',
        'display_currency'
      );
    }

    if (!badge_icon || badge_icon.trim() === '') {
      throw new ValidationError('Badge icon cannot be empty', 'badge_icon');
    }

    if (!number_format || number_format.trim() === '') {
      throw new ValidationError('Number format cannot be empty', 'number_format');
    }

    const resolvedSpaceId = space_id && space_id.trim() !== '' ? space_id : this.generateSpaceId();

    return this.insertBudget(
      resolvedSpaceId,
      name.trim(),
      display_currency,
      badge_icon,
      number_format,
      create_default_categories
    );
  }

  /**
   * Get budget by ID
   * Not in Go service but useful for TypeScript
   */
  getBudget(id: number): Budget {
    const budgets = this.getAllBudgets();
    const budget = budgets.find((b) => b.ID === id);
    if (!budget) {
      throw new NotFoundError('Budget', id);
    }
    return budget;
  }

  private generateSpaceId(): string {
    try {
      const cryptoObj: Crypto | undefined = (globalThis as { crypto?: Crypto })?.crypto;
      if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
        return cryptoObj.randomUUID();
      }
      if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
        const buffer = new Uint8Array(16);
        cryptoObj.getRandomValues(buffer);
        buffer[6] = (buffer[6] & 0x0f) | 0x40;
        buffer[8] = (buffer[8] & 0x3f) | 0x80;
        const hex = Array.from(buffer, (b) => b.toString(16).padStart(2, '0'));
        return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
          .slice(6, 8)
          .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
      }
    } catch {
      /* ignore fallback */
    }

    const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
    return template.replace(/[xy]/g, (char) => {
      const rand = (Math.random() * 16) | 0;
      const value = char === 'x' ? rand : (rand & 0x3) | 0x8;
      return value.toString(16);
    });
  }
}

// Re-export types for external use
export type { Budget, CreateBudgetRequest, RtaMode } from './types.js';
