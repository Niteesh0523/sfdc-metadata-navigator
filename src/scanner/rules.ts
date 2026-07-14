/**
 * SFDC Metadata Navigator - Apex Code Analysis Rules
 *
 * Rule-based pattern matching engine for detecting common Apex anti-patterns.
 * All rules are deterministic (no AI) and run client-side in the browser.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = 'critical' | 'warning' | 'info';

export type RuleCategory =
  | 'bulkification'
  | 'performance'
  | 'security'
  | 'best-practice'
  | 'maintainability';

export interface RuleViolation {
  /** Rule identifier */
  ruleId: string;
  /** Human-readable rule name */
  ruleName: string;
  /** Description of what's wrong and why */
  message: string;
  /** Severity level */
  severity: Severity;
  /** Category for grouping */
  category: RuleCategory;
  /** Line number (1-indexed) where the violation occurs */
  line: number;
  /** The offending code snippet (trimmed) */
  snippet: string;
  /** Suggestion for fixing the issue */
  fix: string;
}

export interface ScanResult {
  /** Apex class name */
  className: string;
  /** Salesforce record ID */
  classId: string;
  /** Total line count */
  lineCount: number;
  /** Violations found */
  violations: RuleViolation[];
}

export interface Rule {
  id: string;
  name: string;
  description: string;
  severity: Severity;
  category: RuleCategory;
  fix: string;
  /** Detect violations in the given source code */
  scan(source: string, className: string): RuleViolation[];
}

// ---------------------------------------------------------------------------
// Utility: Loop Detection
// ---------------------------------------------------------------------------

/**
 * Finds all line ranges that are inside a loop (for, while, do-while).
 * Returns a Set of line numbers (1-indexed) that are inside a loop body.
 */
function getLoopLineNumbers(source: string): Set<number> {
  const lines = source.split('\n');
  const loopLines = new Set<number>();
  const loopStartPattern = /^\s*(for\s*\(|while\s*\(|do\s*\{)/i;

  let braceDepth = 0;
  let insideLoop = false;
  let loopBraceStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this line starts a loop
    if (!insideLoop && loopStartPattern.test(line)) {
      insideLoop = true;
      loopBraceStart = braceDepth;
    }

    // Count braces
    for (const ch of line) {
      if (ch === '{') {
        braceDepth++;
        if (insideLoop && braceDepth === loopBraceStart + 1) {
          // Entering loop body
        }
      } else if (ch === '}') {
        braceDepth--;
        if (insideLoop && braceDepth <= loopBraceStart) {
          insideLoop = false;
        }
      }
    }

    if (insideLoop) {
      loopLines.add(i + 1); // 1-indexed
    }
  }

  return loopLines;
}

/**
 * Checks if a line is inside a comment (single-line // or block comment).
 * Simple heuristic — not a full parser but covers common cases.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Rule: SOQL Query Inside Loop
 * Detects SELECT statements inside for/while/do loops.
 */
const soqlInLoopRule: Rule = {
  id: 'SOQL_IN_LOOP',
  name: 'SOQL Query Inside Loop',
  description: 'SOQL queries inside loops can hit the 100-query governor limit. Move the query outside the loop and use collections.',
  severity: 'critical',
  category: 'bulkification',
  fix: 'Move the SOQL query before the loop. Use a Map or Set to collect IDs, then query once with a WHERE IN clause.',
  scan(source: string): RuleViolation[] {
    const violations: RuleViolation[] = [];
    const lines = source.split('\n');
    const loopLines = getLoopLineNumbers(source);
    const soqlPattern = /\[\s*SELECT\s+/i;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      if (loopLines.has(lineNum) && !isCommentLine(lines[i]) && soqlPattern.test(lines[i])) {
        violations.push({
          ruleId: this.id,
          ruleName: this.name,
          message: this.description,
          severity: this.severity,
          category: this.category,
          line: lineNum,
          snippet: lines[i].trim(),
          fix: this.fix,
        });
      }
    }

    return violations;
  },
};

/**
 * Rule: DML Statement Inside Loop
 * Detects insert/update/delete/upsert/undelete inside loops.
 */
const dmlInLoopRule: Rule = {
  id: 'DML_IN_LOOP',
  name: 'DML Statement Inside Loop',
  description: 'DML operations inside loops can hit the 150-DML-statement governor limit. Collect records in a list and perform DML outside the loop.',
  severity: 'critical',
  category: 'bulkification',
  fix: 'Collect records into a List<SObject> inside the loop, then perform a single DML statement after the loop.',
  scan(source: string): RuleViolation[] {
    const violations: RuleViolation[] = [];
    const lines = source.split('\n');
    const loopLines = getLoopLineNumbers(source);
    // Match DML keywords at start of statement (after whitespace or semicolon)
    const dmlPattern = /\b(insert|update|delete|upsert|undelete)\s+/i;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      if (loopLines.has(lineNum) && !isCommentLine(lines[i]) && dmlPattern.test(lines[i])) {
        // Exclude false positives: "update" in variable names, comments, strings
        const trimmed = lines[i].trim();
        // Skip if it looks like a method call (e.g., updateAccount()) or variable (e.g., updateMap)
        if (/\b(insert|update|delete|upsert|undelete)\s+[a-zA-Z]/i.test(trimmed)) {
          violations.push({
            ruleId: this.id,
            ruleName: this.name,
            message: this.description,
            severity: this.severity,
            category: this.category,
            line: lineNum,
            snippet: trimmed,
            fix: this.fix,
          });
        }
      }
    }

    return violations;
  },
};

/**
 * Rule: Hardcoded Salesforce Record ID
 * Detects 15 or 18-character IDs that look like Salesforce record IDs.
 */
const hardcodedIdRule: Rule = {
  id: 'HARDCODED_ID',
  name: 'Hardcoded Record ID',
  description: 'Hardcoded Salesforce IDs break across environments (sandbox vs production). Use Custom Metadata, Custom Labels, or queries instead.',
  severity: 'warning',
  category: 'maintainability',
  fix: 'Replace hardcoded IDs with Custom Metadata Types, Custom Labels, Custom Settings, or SOQL queries using DeveloperName.',
  scan(source: string): RuleViolation[] {
    const violations: RuleViolation[] = [];
    const lines = source.split('\n');
    // Salesforce ID pattern: starts with known 3-char prefix, is 15 or 18 chars
    // Common prefixes: 001 (Account), 003 (Contact), 00D (Org), 005 (User), 01p (ApexClass), etc.
    const idPattern = /['"]([0-9a-zA-Z]{15}|[0-9a-zA-Z]{18})['"]/g;
    // Known SF ID prefixes (3-char key prefixes)
    const sfPrefixes = /^(001|003|005|006|00D|00G|00Q|00T|00U|01p|01q|012|01I|01t|02i|03d|04t|068|069|07L|08e|0BM|0DM)/;

    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i])) continue;

      let match;
      idPattern.lastIndex = 0;
      while ((match = idPattern.exec(lines[i])) !== null) {
        const id = match[1];
        // Only flag if it starts with a known SF key prefix
        if (sfPrefixes.test(id)) {
          violations.push({
            ruleId: this.id,
            ruleName: this.name,
            message: this.description,
            severity: this.severity,
            category: this.category,
            line: i + 1,
            snippet: lines[i].trim(),
            fix: this.fix,
          });
          break; // One violation per line is enough
        }
      }
    }

    return violations;
  },
};

/**
 * Rule: SOQL Without WHERE Clause or LIMIT
 * Detects queries that could return unbounded results.
 */
const unboundedSoqlRule: Rule = {
  id: 'UNBOUNDED_SOQL',
  name: 'SOQL Without LIMIT or WHERE',
  description: 'SOQL queries without WHERE or LIMIT can return excessive records, hitting heap size limits or causing performance issues.',
  severity: 'warning',
  category: 'performance',
  fix: 'Add a WHERE clause to filter results, or add LIMIT to cap the result set size.',
  scan(source: string): RuleViolation[] {
    const violations: RuleViolation[] = [];
    const lines = source.split('\n');
    // Find SOQL queries and check for WHERE/LIMIT
    // Join lines to handle multi-line queries
    const fullSource = source;
    const queryPattern = /\[\s*SELECT\s+[^\]]+\]/gi;

    let match;
    while ((match = queryPattern.exec(fullSource)) !== null) {
      const query = match[0];
      const hasWhere = /\bWHERE\b/i.test(query);
      const hasLimit = /\bLIMIT\b/i.test(query);

      if (!hasWhere && !hasLimit) {
        // Find which line this is on
        const beforeMatch = fullSource.substring(0, match.index);
        const lineNum = beforeMatch.split('\n').length;
        const lineText = lines[lineNum - 1] || '';

        if (!isCommentLine(lineText)) {
          violations.push({
            ruleId: this.id,
            ruleName: this.name,
            message: this.description,
            severity: this.severity,
            category: this.category,
            line: lineNum,
            snippet: lineText.trim(),
            fix: this.fix,
          });
        }
      }
    }

    return violations;
  },
};

/**
 * Rule: Missing Null Check
 * Detects accessing properties on query results without null checking.
 */
const queryWithoutNullCheckRule: Rule = {
  id: 'QUERY_NO_NULL_CHECK',
  name: 'Query Result Used Without Null Check',
  description: 'Accessing .get(0) or [0] on a query result without checking if the list is empty can throw a ListException.',
  severity: 'warning',
  category: 'best-practice',
  fix: 'Check if the list is empty before accessing elements: if (!results.isEmpty()) { ... results[0] ... }',
  scan(source: string): RuleViolation[] {
    const violations: RuleViolation[] = [];
    const lines = source.split('\n');
    // Pattern: accessing [0] or .get(0) without a preceding isEmpty() or size() check
    const directAccessPattern = /\[\s*0\s*\]|\.get\(\s*0\s*\)/;

    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i])) continue;

      if (directAccessPattern.test(lines[i])) {
        // Check if there's a null/empty check in the preceding 3 lines
        const contextStart = Math.max(0, i - 3);
        const context = lines.slice(contextStart, i).join('\n');
        const hasCheck = /\.isEmpty\(\)|\.size\(\)\s*>|\.size\(\)\s*!=\s*0|!=\s*null|\.isNotEmpty\(\)/i.test(context);

        if (!hasCheck) {
          violations.push({
            ruleId: this.id,
            ruleName: this.name,
            message: this.description,
            severity: this.severity,
            category: this.category,
            line: i + 1,
            snippet: lines[i].trim(),
            fix: this.fix,
          });
        }
      }
    }

    return violations;
  },
};

/**
 * Rule: Trigger Without Handler Pattern
 * Detects triggers that contain business logic directly.
 */
const triggerWithLogicRule: Rule = {
  id: 'TRIGGER_WITH_LOGIC',
  name: 'Business Logic in Trigger',
  description: 'Triggers should delegate to handler classes. Business logic directly in triggers makes code harder to test and maintain.',
  severity: 'warning',
  category: 'best-practice',
  fix: 'Create a TriggerHandler class and move all logic there. The trigger should only call the handler.',
  scan(source: string, className: string): RuleViolation[] {
    const violations: RuleViolation[] = [];
    const lines = source.split('\n');

    // Check if this is a trigger
    const isTrigger = /^\s*trigger\s+\w+\s+on\s+/im.test(source);
    if (!isTrigger) return [];

    // If trigger has more than 20 lines of actual code, it likely has logic
    const codeLines = lines.filter(l => !isCommentLine(l) && l.trim().length > 0);
    if (codeLines.length > 20) {
      violations.push({
        ruleId: this.id,
        ruleName: this.name,
        message: this.description,
        severity: this.severity,
        category: this.category,
        line: 1,
        snippet: lines[0].trim(),
        fix: this.fix,
      });
    }

    // Also flag if trigger contains SOQL or DML directly
    const hasSoql = /\[\s*SELECT\s+/i.test(source);
    const hasDml = /\b(insert|update|delete|upsert)\s+/i.test(source);
    if (hasSoql || hasDml) {
      if (violations.length === 0) {
        violations.push({
          ruleId: this.id,
          ruleName: this.name,
          message: 'Trigger contains SOQL or DML statements directly. Delegate to a handler class.',
          severity: this.severity,
          category: this.category,
          line: 1,
          snippet: lines[0].trim(),
          fix: this.fix,
        });
      }
    }

    return violations;
  },
};

/**
 * Rule: System.debug Left in Code
 * Detects debug statements that should be removed before production.
 */
const debugStatementRule: Rule = {
  id: 'DEBUG_STATEMENT',
  name: 'System.debug Statement',
  description: 'System.debug statements impact performance and should be removed or wrapped in a logging utility before deployment.',
  severity: 'info',
  category: 'performance',
  fix: 'Remove System.debug statements or replace with a custom logging framework that can be toggled.',
  scan(source: string): RuleViolation[] {
    const violations: RuleViolation[] = [];
    const lines = source.split('\n');
    const debugPattern = /System\.debug\s*\(/i;

    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i])) continue;

      if (debugPattern.test(lines[i])) {
        violations.push({
          ruleId: this.id,
          ruleName: this.name,
          message: this.description,
          severity: this.severity,
          category: this.category,
          line: i + 1,
          snippet: lines[i].trim(),
          fix: this.fix,
        });
      }
    }

    return violations;
  },
};

/**
 * Rule: SOQL Injection Risk
 * Detects dynamic SOQL with string concatenation (potential injection).
 */
const soqlInjectionRule: Rule = {
  id: 'SOQL_INJECTION',
  name: 'Potential SOQL Injection',
  description: 'Dynamic SOQL using string concatenation with user input is vulnerable to SOQL injection attacks.',
  severity: 'critical',
  category: 'security',
  fix: 'Use bind variables (:variableName) in SOQL, or use String.escapeSingleQuotes() for dynamic queries with Database.query().',
  scan(source: string): RuleViolation[] {
    const violations: RuleViolation[] = [];
    const lines = source.split('\n');
    // Pattern: Database.query( with string concatenation using +
    const dynamicQueryPattern = /Database\.query\s*\(/i;
    const concatenationPattern = /['"]\s*\+|\+\s*['"]/;

    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i])) continue;

      if (dynamicQueryPattern.test(lines[i])) {
        // Check this line and next few lines for string concatenation
        const context = lines.slice(i, Math.min(i + 5, lines.length)).join(' ');
        if (concatenationPattern.test(context) && !/escapeSingleQuotes/i.test(context)) {
          violations.push({
            ruleId: this.id,
            ruleName: this.name,
            message: this.description,
            severity: this.severity,
            category: this.category,
            line: i + 1,
            snippet: lines[i].trim(),
            fix: this.fix,
          });
        }
      }
    }

    return violations;
  },
};

/**
 * Rule: Missing SObjectType Check (without sharing/with sharing)
 * Detects classes that don't specify sharing model.
 */
const missingSharingRule: Rule = {
  id: 'MISSING_SHARING',
  name: 'Missing Sharing Declaration',
  description: 'Classes without "with sharing" or "without sharing" run in the current user context by default, which can be unpredictable.',
  severity: 'warning',
  category: 'security',
  fix: 'Explicitly declare "with sharing" (to enforce record-level security) or "without sharing" (if intentionally bypassing) on the class.',
  scan(source: string): RuleViolation[] {
    const violations: RuleViolation[] = [];
    const lines = source.split('\n');
    // Check for class declarations without sharing keyword
    const classPattern = /^\s*(public|private|global)\s+(virtual\s+|abstract\s+)?(class)\s+\w+/i;
    const sharingPattern = /(with\s+sharing|without\s+sharing|inherited\s+sharing)/i;

    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i])) continue;

      if (classPattern.test(lines[i]) && !sharingPattern.test(lines[i])) {
        // Check if sharing is on the same line or nearby
        const context = lines.slice(Math.max(0, i - 1), i + 2).join(' ');
        if (!sharingPattern.test(context)) {
          violations.push({
            ruleId: this.id,
            ruleName: this.name,
            message: this.description,
            severity: this.severity,
            category: this.category,
            line: i + 1,
            snippet: lines[i].trim(),
            fix: this.fix,
          });
        }
      }
    }

    return violations;
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** All available rules */
export const ALL_RULES: Rule[] = [
  soqlInLoopRule,
  dmlInLoopRule,
  hardcodedIdRule,
  unboundedSoqlRule,
  queryWithoutNullCheckRule,
  triggerWithLogicRule,
  debugStatementRule,
  soqlInjectionRule,
  missingSharingRule,
];

/**
 * Runs all rules against the given Apex source code.
 *
 * @param source - The full Apex class source code
 * @param className - The name of the class (used for context in some rules)
 * @param classId - The Salesforce record ID of the class
 * @returns ScanResult with all violations found
 */
export function analyzeApexClass(
  source: string,
  className: string,
  classId: string
): ScanResult {
  const violations: RuleViolation[] = [];

  for (const rule of ALL_RULES) {
    const ruleViolations = rule.scan(source, className);
    violations.push(...ruleViolations);
  }

  // Sort by line number
  violations.sort((a, b) => a.line - b.line);

  return {
    className,
    classId,
    lineCount: source.split('\n').length,
    violations,
  };
}
