'use strict';
/*
 * Database schema: the same 17 tables, columns and constraint names as v3,
 * matching the ERD and Data Dictionary in Chapter 3. createSchema() creates
 * missing tables and adds missing columns; it never drops or changes data,
 * so an existing v3 database (SQLite or MySQL) opens as is.
 */
const db = require('./db');

const TABLES = [
  ['municipalities', (t) => {
    t.increments('id').primary();
    t.string('name', 80).notNullable().unique('uq_municipalities_name');
    t.string('psgc_code', 12).unique('uq_municipalities_psgc_code');
    t.boolean('is_capital').notNullable().defaultTo(false);
  }],
  ['users', (t) => {
    t.increments('id').primary();
    t.string('first_name', 80).notNullable();
    t.string('last_name', 80).notNullable();
    t.string('email', 160).notNullable().unique('uq_users_email');
    t.string('username', 40).notNullable().unique('uq_users_username');
    t.string('password_hash', 100);
    t.string('role', 20).notNullable().defaultTo('officer');
    t.string('status', 20).notNullable().defaultTo('pending');
    t.string('contact_number', 20);
    t.string('office', 160).defaultTo('DOST Davao Oriental');
    t.integer('failed_login_attempts').notNullable().defaultTo(0);
    t.boolean('is_locked').notNullable().defaultTo(false);
    t.datetime('locked_at');
    t.datetime('last_login_at');
    t.datetime('password_changed_at');
    t.datetime('privacy_consent_at');
    t.integer('approved_by_id').unsigned().references('id').inTable('users');
    t.datetime('approved_at');
    t.string('signup_status_token', 64).unique('uq_users_signup_status_token');
    t.string('pref_font_size', 10).notNullable().defaultTo('medium');
    t.string('pref_theme', 10).notNullable().defaultTo('light');
    t.integer('pref_default_municipality_id').unsigned().references('id').inTable('municipalities');
    t.string('pref_export_format', 10).notNullable().defaultTo('pdf');
    t.boolean('pref_email_high_risk').notNullable().defaultTo(true);
    t.boolean('pref_weekly_digest').notNullable().defaultTo(false);
    t.text('totp_secret');                       // encrypted; two-step verification
    t.boolean('totp_enabled').notNullable().defaultTo(false);
    t.text('totp_recovery_json');                // hashed one-time recovery codes
    t.datetime('created_at').notNullable();
    t.datetime('updated_at').notNullable();
  }],
  ['user_sessions', (t) => {
    t.string('id', 64).primary();
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').index('ix_user_sessions_user_id');
    t.datetime('created_at').notNullable();
    t.datetime('last_seen_at').notNullable();
    t.string('ip_address', 45);
    t.string('user_agent', 255);
    t.datetime('revoked_at');
    t.string('revoke_reason', 40);
  }],
  ['password_tokens', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').index('ix_password_tokens_user_id');
    t.string('token_hash', 64).notNullable().unique('uq_password_tokens_token_hash');
    t.string('purpose', 10).notNullable();
    t.datetime('expires_at').notNullable();
    t.datetime('used_at');
    t.datetime('created_at').notNullable();
  }],
  ['secondary_schools', (t) => {
    t.increments('id').primary();
    t.string('name', 160).notNullable();
    t.integer('municipality_id').unsigned().notNullable().references('id').inTable('municipalities').index('ix_secondary_schools_municipality_id');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.unique(['name', 'municipality_id'], { indexName: 'uq_secondary_schools_name_municipality' });
  }],
  ['heis', (t) => {
    t.increments('id').primary();
    t.string('name', 160).notNullable().unique('uq_heis_name');
    t.integer('municipality_id').unsigned().references('id').inTable('municipalities');
    t.boolean('is_active').notNullable().defaultTo(true);
  }],
  ['scholarship_programs', (t) => {
    t.increments('id').primary();
    t.string('name', 60).notNullable().unique('uq_scholarship_programs_name');
    t.boolean('is_active').notNullable().defaultTo(true);
  }],
  ['scholarship_cycles', (t) => {
    t.increments('id').primary();
    t.string('label', 20).notNullable().unique('uq_scholarship_cycles_label');
    t.integer('start_year').notNullable();
    t.boolean('is_active').notNullable().defaultTo(true);
  }],
  ['import_batches', (t) => {
    t.increments('id').primary();
    t.string('filename', 255).notNullable();
    t.integer('uploaded_by_id').unsigned().notNullable().references('id').inTable('users');
    t.datetime('uploaded_at').notNullable();
    t.integer('total_rows').notNullable().defaultTo(0);
    t.integer('valid_rows').notNullable().defaultTo(0);
    t.integer('error_rows').notNullable().defaultTo(0);
    t.string('status', 15).notNullable().defaultTo('previewed');
    t.string('kind', 15).notNullable().defaultTo('scholars');
    t.text('errors_json', 'longtext');
    t.text('payload_json', 'longtext');
    t.datetime('committed_at');
  }],
  ['scholars', (t) => {
    t.increments('id').primary();
    t.string('scholar_code', 20).notNullable().unique('uq_scholars_scholar_code');   // scholars are identified by Scholar ID only
    t.string('gender', 10).notNullable();
    t.date('birth_date').notNullable();
    t.string('mobile_number', 20).notNullable();
    t.string('email', 160);
    t.integer('program_id').unsigned().notNullable().references('id').inTable('scholarship_programs').index('ix_scholars_program_id');
    t.integer('cycle_id').unsigned().notNullable().references('id').inTable('scholarship_cycles').index('ix_scholars_cycle_id');
    t.integer('municipality_id').unsigned().notNullable().references('id').inTable('municipalities').index('ix_scholars_municipality_id');
    t.integer('secondary_school_id').unsigned().notNullable().references('id').inTable('secondary_schools');
    t.date('enrollment_date').notNullable();
    t.integer('hei_id').unsigned().notNullable().references('id').inTable('heis').index('ix_scholars_hei_id');
    t.string('degree_program', 150).notNullable();
    t.smallint('year_level').notNullable();
    t.string('status', 25).notNullable().defaultTo('active').index('ix_scholars_status');
    t.string('academic_standing', 20);
    t.boolean('is_deactivated').notNullable().defaultTo(false).index('ix_scholars_is_deactivated');
    t.boolean('is_anonymized').notNullable().defaultTo(false);
    t.datetime('anonymized_at');
    t.datetime('deactivated_at');
    t.integer('deactivated_by_id').unsigned().references('id').inTable('users');
    t.integer('created_by_id').unsigned().references('id').inTable('users');
    t.integer('updated_by_id').unsigned().references('id').inTable('users');
    t.integer('import_batch_id').unsigned().references('id').inTable('import_batches');
    t.datetime('created_at').notNullable();
    t.datetime('updated_at').notNullable();
  }],
  ['academic_records', (t) => {
    t.increments('id').primary();
    t.integer('scholar_id').unsigned().notNullable().references('id').inTable('scholars').index('ix_academic_records_scholar_id');
    t.string('academic_year', 20).notNullable();
    t.string('semester', 20).notNullable();
    t.smallint('semester_order').notNullable();
    t.decimal('gwa', 5, 2).notNullable();
    t.string('gwa_scale', 10).notNullable().defaultTo('grade');
    t.smallint('year_level_at_record').notNullable();
    t.string('standing', 20).notNullable();
    t.date('date_recorded').notNullable();
    t.string('enrollment_status', 30);           // from the DOST data (Regular, Irregular, On Leave ...)
    t.smallint('units_enrolled');
    t.smallint('failed_subjects');
    t.integer('encoded_by_id').unsigned().references('id').inTable('users');
    t.datetime('created_at').notNullable();
    t.unique(['scholar_id', 'academic_year', 'semester'], { indexName: 'uq_academic_records_scholar_term' });
  }],
  ['stipend_disbursements', (t) => {
    t.increments('id').primary();
    t.integer('scholar_id').unsigned().notNullable().references('id').inTable('scholars').index('ix_stipend_disbursements_scholar_id');
    t.string('period', 60).notNullable();
    t.decimal('amount', 12, 2).notNullable();
    t.string('status', 15).notNullable().defaultTo('Pending');
    t.date('date_released');
    t.string('remarks', 255);
    t.integer('encoded_by_id').unsigned().references('id').inTable('users');
    t.datetime('created_at').notNullable();
    t.datetime('updated_at').notNullable();
  }],
  ['graduation_records', (t) => {
    t.increments('id').primary();
    t.integer('scholar_id').unsigned().notNullable().references('id').inTable('scholars').unique('uq_graduation_records_scholar_id');
    t.date('expected_graduation');
    t.date('actual_graduation');
    t.string('status', 20).notNullable().defaultTo('On Track');
    t.string('delay_reason', 255);
    t.integer('updated_by_id').unsigned().references('id').inTable('users');
    t.datetime('updated_at').notNullable();
  }],
  ['termination_requests', (t) => {
    t.increments('id').primary();
    t.integer('scholar_id').unsigned().notNullable().references('id').inTable('scholars').index('ix_termination_requests_scholar_id');
    t.string('grounds', 160).notNullable();
    t.text('notes').notNullable();
    t.date('proposed_effective_date').notNullable();
    t.string('status', 15).notNullable().defaultTo('pending').index('ix_termination_requests_status');
    t.integer('requested_by_id').unsigned().notNullable().references('id').inTable('users');
    t.datetime('requested_at').notNullable();
    t.integer('reviewed_by_id').unsigned().references('id').inTable('users');
    t.datetime('reviewed_at');
    t.text('review_remarks');
    t.datetime('withdrawn_at');
    t.text('withdrawal_reason');
    t.datetime('reversed_at');
    t.integer('reversed_by_id').unsigned().references('id').inTable('users');
    t.text('reversal_remarks');
  }],
  ['scholar_documents', (t) => {
    t.increments('id').primary();
    t.integer('scholar_id').unsigned().notNullable().references('id').inTable('scholars').index('ix_scholar_documents_scholar_id');
    t.integer('termination_request_id').unsigned().references('id').inTable('termination_requests');
    t.string('doc_type', 40).notNullable();
    t.string('description', 255);
    t.string('original_filename', 255).notNullable();
    t.string('stored_name', 80).notNullable().unique('uq_scholar_documents_stored_name');
    t.string('mime_type', 60).notNullable();
    t.integer('size_bytes').notNullable();
    t.string('sha256', 64).notNullable();
    t.integer('uploaded_by_id').unsigned().notNullable().references('id').inTable('users');
    t.datetime('uploaded_at').notNullable();
    t.boolean('is_deleted').notNullable().defaultTo(false);
    t.datetime('deleted_at');
    t.integer('deleted_by_id').unsigned().references('id').inTable('users');
    t.string('delete_reason', 255);
  }],
  ['school_applicants', (t) => {
    t.increments('id').primary();
    t.string('cycle_label', 20).notNullable();
    t.integer('start_year').notNullable().index('ix_school_applicants_start_year');
    t.string('school_name', 160).notNullable();
    t.integer('municipality_id').unsigned().references('id').inTable('municipalities').index('ix_school_applicants_municipality_id');
    t.string('program', 60);
    t.integer('applicants').notNullable().defaultTo(0);
    t.integer('qualifiers').notNullable().defaultTo(0);
    t.integer('awardees').notNullable().defaultTo(0);
    t.integer('graduating_class_size');
    t.datetime('created_at').notNullable();
  }],
  ['scholar_risk', (t) => {
    t.integer('scholar_id').unsigned().primary().references('id').inTable('scholars');
    t.string('level', 20).notNullable();
    t.text('probabilities_json');
    t.text('top_factors_json');
    t.string('model_version', 40).notNullable();
    t.datetime('scored_at').notNullable();
  }],
  ['intervention_cases', (t) => {
    t.increments('id').primary();
    t.integer('scholar_id').unsigned().notNullable().references('id').inTable('scholars').index('ix_intervention_cases_scholar_id');
    t.string('risk_level', 20).notNullable();
    t.string('risk_source', 20).notNullable();
    t.string('reason', 255).notNullable();
    t.text('recommended_actions_json');
    t.string('status', 20).notNullable().defaultTo('open').index('ix_intervention_cases_status');
    t.integer('claimed_by_id').unsigned().references('id').inTable('users');
    t.datetime('claimed_at');
    t.string('outcome', 40);
    t.text('outcome_notes');
    t.datetime('closed_at');
    t.integer('closed_by_id').unsigned().references('id').inTable('users');
    t.datetime('created_at').notNullable();
    t.datetime('updated_at').notNullable();
  }],
  ['intervention_logs', (t) => {
    t.increments('id').primary();
    t.integer('case_id').unsigned().notNullable().references('id').inTable('intervention_cases').index('ix_intervention_logs_case_id');
    t.integer('user_id').unsigned().references('id').inTable('users');
    t.string('action_type', 40).notNullable();
    t.text('notes');
    t.datetime('created_at').notNullable();
  }],
  ['kpi_reports', (t) => {
    t.increments('id').primary();
    t.string('report_type', 40).notNullable();
    t.string('title', 200).notNullable();
    t.string('period_label', 60);
    t.string('format', 10).notNullable();
    t.string('stored_name', 80).notNullable().unique('uq_kpi_reports_stored_name');
    t.integer('size_bytes').notNullable();
    t.text('params_json');
    t.integer('generated_by_id').unsigned().references('id').inTable('users');
    t.datetime('generated_at').notNullable();
  }],
  ['notifications', (t) => {
    t.increments('id').primary();
    t.integer('user_id').unsigned().notNullable().references('id').inTable('users').index('ix_notifications_user_id');
    t.string('kind', 30).notNullable();
    t.string('title', 200).notNullable();
    t.string('body', 300);
    t.string('link', 200);
    t.string('urgency', 10).notNullable().defaultTo('gray');
    t.boolean('is_read').notNullable().defaultTo(false).index('ix_notifications_is_read');
    t.datetime('created_at').notNullable();
  }],
  ['audit_logs', (t) => {
    t.increments('id').primary();
    t.datetime('created_at').notNullable().index('ix_audit_logs_created_at');
    t.integer('user_id').unsigned().references('id').inTable('users');
    t.string('username', 80);
    t.string('category', 15).notNullable().index('ix_audit_logs_category');
    t.string('action', 80).notNullable();
    t.string('target_type', 30);
    t.string('target_id', 40);
    t.string('target_label', 200);
    t.text('details_json');
    t.string('ip_address', 45);
    t.string('prev_hash', 64).notNullable();
    t.string('entry_hash', 64).notNullable().unique('uq_audit_logs_entry_hash');
  }],
];
const TABLE_NAMES = TABLES.map(([n]) => n);
// Tables in an order where every foreign key points to an earlier table.
const DEPENDENCY_ORDER = ['municipalities', 'users', 'user_sessions', 'password_tokens', 'secondary_schools', 'heis',
  'scholarship_programs', 'scholarship_cycles', 'import_batches', 'scholars', 'academic_records', 'stipend_disbursements',
  'graduation_records', 'termination_requests', 'scholar_documents', 'school_applicants', 'scholar_risk', 'intervention_cases',
  'intervention_logs', 'kpi_reports', 'notifications', 'audit_logs'];

async function createSchema(log = () => {}) {
  const k = db();
  const added = [];
  for (const [name, build] of TABLES) {
    if (!(await k.schema.hasTable(name))) {
      await k.schema.createTable(name, (t) => {
        if (db.isMySQL()) { t.engine('InnoDB'); t.charset('utf8mb4'); t.collate('utf8mb4_unicode_ci'); }
        build(t);
      });
      added.push(`table ${name}`);
      continue;
    }
    // Add any column missing from an older database (never drops anything).
    const probe = [];
    const fake = new Proxy({}, { get: (_, method) => (...args) => {
      if (typeof args[0] === 'string' && !['primary', 'unique', 'index', 'engine', 'charset', 'collate'].includes(method)) probe.push(args[0]);
      return new Proxy({}, { get: () => () => fake_chain });
    } });
    const fake_chain = new Proxy({}, { get: () => () => fake_chain });
    build(fake);
    for (const col of probe) {
      if (!(await k.schema.hasColumn(name, col))) {
        await k.schema.alterTable(name, (t) => {
          const cols = []; const sub = new Proxy({}, { get: (_, m) => (...a) => { if (a[0] === col) { cols.push([m, a]); } return chainFor(m, a); } });
          function chainFor(m, a) { if (a[0] !== col) return fake_chain; const c = t[m](...a); return nullableChain(c); }
          function nullableChain(c) { return new Proxy(c, { get: (target, p) => (p === 'notNullable' ? () => nullableChain(target) : (typeof target[p] === 'function' ? (...x) => nullableChain(target[p](...x)) : target[p])) }); }
          build(sub);
        });
        added.push(`${name}.${col}`);
      }
    }
  }
  // Scholar names are no longer collected: remove the name columns from older databases.
  const nameCols = [];
  for (const col of ['last_name', 'first_name', 'middle_name']) if (await k.schema.hasColumn('scholars', col)) nameCols.push(col);
  if (nameCols.length) {
    if (db.isMySQL()) {
      const idx = await k.raw("SHOW INDEX FROM scholars WHERE Key_name = 'ix_scholars_name_dob'");
      if (idx[0].length) await k.raw('DROP INDEX ix_scholars_name_dob ON scholars');
      await k.schema.alterTable('scholars', (t) => nameCols.forEach((c) => t.dropColumn(c)));
    } else {
      await k.raw('DROP INDEX IF EXISTS ix_scholars_name_dob');
      for (const c of nameCols) await k.raw(`ALTER TABLE scholars DROP COLUMN ${c}`);   // SQLite 3.35+
    }
    added.push(`removed scholar name columns (${nameCols.join(', ')})`);
  }
  if (db.isMySQL()) await installAuditTriggers();
  if (added.length) log(`Database upgraded: ${added.join(', ')}`);
  return added;
}

async function installAuditTriggers() {
  const k = db();
  for (const [name, event] of [['audit_logs_no_update', 'UPDATE'], ['audit_logs_no_delete', 'DELETE']]) {
    await k.raw(`DROP TRIGGER IF EXISTS ${name}`);
    await k.raw(`CREATE TRIGGER ${name} BEFORE ${event} ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only'`);
  }
}
async function dropAuditTriggers() {
  if (!db.isMySQL()) return;
  await db().raw('DROP TRIGGER IF EXISTS audit_logs_no_update');
  await db().raw('DROP TRIGGER IF EXISTS audit_logs_no_delete');
}

module.exports = { createSchema, installAuditTriggers, dropAuditTriggers, TABLE_NAMES, DEPENDENCY_ORDER };
