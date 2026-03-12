-- ============================================================================
-- GRIDx STS Prepaid Electricity Vending System — Migration v2
-- ============================================================================
-- Run this script AFTER the initial schema.sql has been applied.
-- It adds new tables and columns required for multi-meter support,
-- transaction component breakdowns, batch management, commissions,
-- archiving, notifications, and field-level permissions.
--
-- Compatible with MySQL 8.x and MariaDB 10.6+.
-- Uses IF NOT EXISTS / IGNORE to make the migration idempotent.
-- ============================================================================

SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------------
-- 1. customer_meters — multiple meters per ERF / customer
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_meters (
  id            INT            AUTO_INCREMENT PRIMARY KEY,
  customer_id   INT            NOT NULL,
  meter_no      VARCHAR(20)    NOT NULL UNIQUE,
  sgc           VARCHAR(10),
  key_revision  VARCHAR(10),
  meter_make    VARCHAR(50),
  meter_model   VARCHAR(50),
  gps_lat       DECIMAL(10,6),
  gps_lng       DECIMAL(10,6),
  is_primary    BOOLEAN        DEFAULT FALSE,
  status        ENUM('Active','Inactive','Faulty') DEFAULT 'Active',
  installed_at  DATE,
  created_at    TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
  INDEX idx_cm_customer (customer_id),
  INDEX idx_cm_meter    (meter_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. transaction_components — atomic breakdown per NamPower requirement
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transaction_components (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  transaction_id  INT            NOT NULL,
  component_type  ENUM('energy','vat','fixed_charge','rel_levy','arrears','commission','free_units') NOT NULL,
  description     VARCHAR(100),
  amount          DECIMAL(12,2)  NOT NULL DEFAULT 0.00,
  kwh             DECIMAL(10,2)  DEFAULT NULL,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
  INDEX idx_tc_transaction (transaction_id),
  INDEX idx_tc_type        (component_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. sales_batches — group transactions into sales batches
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_batches (
  id                  INT            AUTO_INCREMENT PRIMARY KEY,
  batch_number        VARCHAR(30)    NOT NULL UNIQUE,
  vendor_id           INT,
  operator_id         INT,
  status              ENUM('Open','Closed','Reconciled') DEFAULT 'Open',
  opened_at           TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  closed_at           DATETIME,
  closed_by           INT,
  total_amount        DECIMAL(14,2)  DEFAULT 0.00,
  total_transactions  INT            DEFAULT 0,
  notes               TEXT,
  FOREIGN KEY (vendor_id)   REFERENCES vendors(id),
  FOREIGN KEY (operator_id) REFERENCES users(id),
  INDEX idx_sb_vendor (vendor_id),
  INDEX idx_sb_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 4. banking_batches — track deposits / bank submissions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banking_batches (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  batch_number    VARCHAR(30)    NOT NULL UNIQUE,
  sales_batch_id  INT,
  status          ENUM('Pending','Submitted','Cleared','Rejected') DEFAULT 'Pending',
  bank_reference  VARCHAR(50),
  total_amount    DECIMAL(14,2)  DEFAULT 0.00,
  submitted_at    DATETIME,
  cleared_at      DATETIME,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sales_batch_id) REFERENCES sales_batches(id),
  INDEX idx_bb_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 5. commission_records — vendor commission tracking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commission_records (
  id              INT            AUTO_INCREMENT PRIMARY KEY,
  vendor_id       INT            NOT NULL,
  transaction_id  INT,
  sales_batch_id  INT,
  amount          DECIMAL(12,2)  NOT NULL,
  rate            DECIMAL(5,2)   NOT NULL,
  status          ENUM('Pending','Approved','Paid') DEFAULT 'Pending',
  approved_by     INT,
  paid_at         DATETIME,
  created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (vendor_id)      REFERENCES vendors(id),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  INDEX idx_cr_vendor (vendor_id),
  INDEX idx_cr_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 6. transaction_archive — archived historical transactions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transaction_archive (
  id              INT            PRIMARY KEY,
  reference       VARCHAR(30)    NOT NULL,
  customer_id     INT,
  meter_no        VARCHAR(20)    NOT NULL,
  amount          DECIMAL(12,2)  NOT NULL,
  kwh             DECIMAL(10,2),
  token           VARCHAR(30),
  operator_id     INT,
  vendor_id       INT,
  status          VARCHAR(20),
  type            VARCHAR(20),
  breakdown       JSON,
  reversal_reason TEXT,
  reversed_by     INT,
  reversed_at     DATETIME,
  created_at      TIMESTAMP,
  archived_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ta_reference (reference),
  INDEX idx_ta_meter     (meter_no),
  INDEX idx_ta_created   (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 7. notifications — SMS and email delivery log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id                      INT            AUTO_INCREMENT PRIMARY KEY,
  type                    ENUM('sms','email') NOT NULL,
  recipient               VARCHAR(100)   NOT NULL,
  subject                 VARCHAR(200),
  body                    TEXT           NOT NULL,
  status                  ENUM('Pending','Sent','Failed') DEFAULT 'Pending',
  related_transaction_id  INT,
  error_message           TEXT,
  sent_at                 DATETIME,
  created_at              TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_notif_status (status),
  INDEX idx_notif_type   (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 8. user_permissions — field-level permission overrides
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_permissions (
  id        INT            AUTO_INCREMENT PRIMARY KEY,
  user_id   INT            NOT NULL,
  resource  VARCHAR(50)    NOT NULL,
  action    VARCHAR(20)    NOT NULL,
  allowed   BOOLEAN        DEFAULT TRUE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uk_user_resource_action (user_id, resource, action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ===========================================================================
-- 9. ALTER existing tables — add new columns
-- ===========================================================================

-- ---- customers: arrears controls + ERF number ----

-- MySQL 8+ does not support IF NOT EXISTS for ADD COLUMN natively.
-- We use a stored procedure to add columns only when they are missing.
-- This approach works on both MySQL 8.x and MariaDB 10.6+.

DROP PROCEDURE IF EXISTS gridx_add_column_if_missing;

DELIMITER //
CREATE PROCEDURE gridx_add_column_if_missing(
  IN p_table  VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = p_table
      AND COLUMN_NAME  = p_column
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

-- customers table additions
CALL gridx_add_column_if_missing('customers', 'arrears_mode',  "ENUM('percentage','fixed') DEFAULT 'percentage' AFTER arrears");
CALL gridx_add_column_if_missing('customers', 'arrears_rate',  "DECIMAL(5,2) DEFAULT 20.00 AFTER arrears_mode");
CALL gridx_add_column_if_missing('customers', 'erf_number',    "VARCHAR(30) AFTER arrears_rate");

-- transactions table additions
CALL gridx_add_column_if_missing('transactions', 'sales_batch_id', "INT AFTER vendor_id");
CALL gridx_add_column_if_missing('transactions', 'token_type',     "ENUM('standard','engineering','free_units','key_change','replacement') DEFAULT 'standard' AFTER sales_batch_id");

-- vendors table additions
CALL gridx_add_column_if_missing('vendors', 'bank_account', "VARCHAR(50) AFTER phone");
CALL gridx_add_column_if_missing('vendors', 'bank_name',    "VARCHAR(100) AFTER bank_account");

-- Clean up the helper procedure
DROP PROCEDURE IF EXISTS gridx_add_column_if_missing;


-- ===========================================================================
-- 10. New system_config entries
-- ===========================================================================
INSERT IGNORE INTO system_config (config_key, config_value) VALUES
  ('smsGatewayProvider',   'africas_talking'),
  ('smsGatewayApiKey',     ''),
  ('smsGatewaySenderId',   'GRIDx'),
  ('emailProvider',        'smtp'),
  ('emailHost',            ''),
  ('emailPort',            '587'),
  ('emailUser',            ''),
  ('emailPassword',        ''),
  ('emailFrom',            'noreply@gridx-meters.com'),
  ('backupSchedule',       'daily'),
  ('backupRetentionDays',  '30'),
  ('archiveAfterDays',     '365'),
  ('lastBackup',           ''),
  ('maxTokensPerDay',      '10'),
  ('ussdChannel',          'disabled'),
  ('iso8583Port',          '8583');

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================================
-- Migration v2 complete
-- ============================================================================
