import type { DatabaseSync } from 'node:sqlite'

// 保留历史增量迁移顺序；所有领域共享一个连接，不各自初始化数据库。
export function migrateDatabase(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS case_design_publications (
      id TEXT PRIMARY KEY,
      design_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      review_id TEXT NOT NULL UNIQUE,
      publication_json TEXT NOT NULL,
      UNIQUE(design_id, version)
    );
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS case_design_reviews (
      id TEXT PRIMARY KEY,
      design_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      review_json TEXT NOT NULL,
      UNIQUE(design_id, revision)
    );
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS case_design_runs (
      id TEXT PRIMARY KEY,
      design_id TEXT NOT NULL,
      status TEXT NOT NULL,
      run_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS case_designs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      revision INTEGER NOT NULL,
      documents_json TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  database.exec(`
    CREATE TABLE IF NOT EXISTS case_assets (
      id TEXT PRIMARY KEY,
      analysis_id TEXT NOT NULL,
      case_key TEXT NOT NULL,
      original_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(analysis_id, case_key)
    );
    CREATE TABLE IF NOT EXISTS case_asset_revisions (
      case_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      resolved_json TEXT NOT NULL,
      review_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(case_id, revision)
    );
  `)
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      source_text TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analysis_reviews (
      analysis_id TEXT PRIMARY KEY,
      confirmed_questions_json TEXT NOT NULL DEFAULT '[]',
      selected_cases_json TEXT NOT NULL DEFAULT '[]',
      question_reviews_json TEXT NOT NULL DEFAULT '{}',
      case_reviews_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      FOREIGN KEY (analysis_id) REFERENCES analyses(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automation_plans (
      id TEXT PRIMARY KEY,
      analysis_id TEXT NOT NULL,
      case_keys_json TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (analysis_id) REFERENCES analyses(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS test_environments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      storage_state_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)

  const reviewColumns = database.prepare('PRAGMA table_info(analysis_reviews)').all() as Array<{ name: string }>
  if (!reviewColumns.some(column => column.name === 'question_reviews_json')) {
    database.exec("ALTER TABLE analysis_reviews ADD COLUMN question_reviews_json TEXT NOT NULL DEFAULT '{}'")
  }
  if (!reviewColumns.some(column => column.name === 'case_reviews_json')) {
    database.exec("ALTER TABLE analysis_reviews ADD COLUMN case_reviews_json TEXT NOT NULL DEFAULT '{}'")
  }

  const analysisColumns = database.prepare('PRAGMA table_info(analyses)').all() as Array<{ name: string }>
  if (!analysisColumns.some(column => column.name === 'file_names_json')) {
    database.exec("ALTER TABLE analyses ADD COLUMN file_names_json TEXT NOT NULL DEFAULT '[]'")
  }

  const executionColumns = database.prepare('PRAGMA table_info(executions)').all() as Array<{ name: string }>
  for (const [name, definition] of [
    ['analysis_id', 'TEXT'], ['automation_plan_id', 'TEXT'], ['environment_id', 'TEXT'],
    ['project_id', 'TEXT'], ['case_keys_json', "TEXT NOT NULL DEFAULT '[]'"], ['plan_json', 'TEXT'], ['rerun_of', 'TEXT'],
  ] as const) {
    if (!executionColumns.some(column => column.name === name)) database.exec(`ALTER TABLE executions ADD COLUMN ${name} ${definition}`)
  }

  const environmentColumns = database.prepare('PRAGMA table_info(test_environments)').all() as Array<{ name: string }>
  if (!environmentColumns.some(column => column.name === 'target_url')) {
    database.exec('ALTER TABLE test_environments ADD COLUMN target_url TEXT')
  }
  database.exec(`
    UPDATE test_environments
    SET target_url = COALESCE(
      (
        SELECT json_extract(executions.result_json, '$.targetUrl')
        FROM executions
        WHERE executions.environment_id = test_environments.id
          AND rtrim(json_extract(executions.result_json, '$.targetUrl'), '/') != rtrim(test_environments.base_url, '/')
        ORDER BY executions.created_at DESC
        LIMIT 1
      ),
      test_environments.base_url
    )
    WHERE target_url IS NULL OR target_url = ''
  `)
}
