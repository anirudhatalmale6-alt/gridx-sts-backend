-- ============================================================================
-- GRIDx STS Prepaid Electricity Vending System — Seed Data
-- ============================================================================
-- Run AFTER schema.sql to populate the database with initial/demo data.
-- All data mirrors the React front-end mockData for consistency.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Users (6)
-- ---------------------------------------------------------------------------
-- Password for all accounts: admin123
-- bcrypt hash: $2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi
INSERT INTO users (name, username, password_hash, role, status, last_login) VALUES
  ('System Admin',    'admin',      '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'ADMIN',      'Online',  '2026-03-12 08:15:00'),
  ('Maria Shikongo',  'maria.s',    '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'SUPERVISOR', 'Online',  '2026-03-12 07:45:00'),
  ('Jonas Amupolo',   'jonas.a',    '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'OPERATOR',   'Online',  '2026-03-12 08:00:00'),
  ('Selma Nakamwe',   'selma.n',    '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'OPERATOR',   'Offline', '2026-03-11 17:30:00'),
  ('Petrus Hamunyela','petrus.h',   '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'OPERATOR',   'Online',  '2026-03-12 06:20:00'),
  ('Anna Iipinge',    'anna.i',     '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'VIEWER',     'Offline', '2026-03-10 14:00:00');

-- ---------------------------------------------------------------------------
-- 2. Vendors (6)
-- ---------------------------------------------------------------------------
INSERT INTO vendors (code, name, location, status, commission_rate, total_sales, transaction_count, balance, operator_name, phone) VALUES
  ('VND-001', 'Windhoek Central',   'Independence Ave, Windhoek',       'Active',      2.00, 245680.50, 1842, 15420.00, 'Jonas Amupolo',    '+264 81 234 5678'),
  ('VND-002', 'Oshakati Main',      'Main Road, Oshakati',              'Active',      2.50, 189320.00, 1456, 12350.00, 'Maria Shikongo',   '+264 81 345 6789'),
  ('VND-003', 'Walvis Bay Harbor',  'Harbor Street, Walvis Bay',        'Active',      2.00, 156780.00, 1234,  8920.00, 'Selma Nakamwe',    '+264 81 456 7890'),
  ('VND-004', 'Rundu Town',         'Main Street, Rundu',               'Low Balance', 2.50,  98450.00,  876,  1250.00, 'Petrus Hamunyela', '+264 81 567 8901'),
  ('VND-005', 'Swakopmund Beach',   'Sam Nujoma Ave, Swakopmund',       'Active',      2.00, 134560.00, 1098,  9870.00, 'Anna Iipinge',     '+264 81 678 9012'),
  ('VND-006', 'Katima Mulilo East', 'Ngoma Road, Katima Mulilo',        'Suspended',   3.00,  67890.00,  534,     0.00, 'David Mwilima',    '+264 81 789 0123');

-- ---------------------------------------------------------------------------
-- 3. Tariff Groups (3) and Tariff Blocks
-- ---------------------------------------------------------------------------
INSERT INTO tariff_groups (code, name, sgc, meter_count, status) VALUES
  ('R1', 'Residential — Prepaid',       '900100', 4850, 'Active'),
  ('R2', 'Residential — Conventional',  '900200', 2340, 'Active'),
  ('C1', 'Commercial — Small Business', '900300', 1120, 'Active');

-- R1 blocks (stepped tariff)
INSERT INTO tariff_blocks (tariff_group_code, name, range_description, range_start, range_end, rate) VALUES
  ('R1', 'Block 1', '0 – 50 kWh',    0.00,   50.00, 1.5214),
  ('R1', 'Block 2', '51 – 350 kWh',  50.01,  350.00, 1.8956),
  ('R1', 'Block 3', '351 – 600 kWh', 350.01, 600.00, 2.3470),
  ('R1', 'Block 4', '601+ kWh',      600.01,   NULL, 2.8120);

-- R2 blocks
INSERT INTO tariff_blocks (tariff_group_code, name, range_description, range_start, range_end, rate) VALUES
  ('R2', 'Block 1', '0 – 100 kWh',   0.00,  100.00, 1.6800),
  ('R2', 'Block 2', '101 – 500 kWh', 100.01, 500.00, 2.1500),
  ('R2', 'Block 3', '501+ kWh',      500.01,   NULL, 2.6400);

-- C1 blocks
INSERT INTO tariff_blocks (tariff_group_code, name, range_description, range_start, range_end, rate) VALUES
  ('C1', 'Block 1', '0 – 500 kWh',    0.00,  500.00, 2.4500),
  ('C1', 'Block 2', '501 – 1000 kWh', 500.01, 1000.00, 2.8900),
  ('C1', 'Block 3', '1001+ kWh',     1000.01,    NULL, 3.2100);

-- ---------------------------------------------------------------------------
-- 4. Customers (12) — Namibian electricity customers
-- ---------------------------------------------------------------------------
INSERT INTO customers (account_no, name, meter_no, area, tariff_group, sgc, key_revision, meter_make, meter_model, balance, arrears, status, phone, address, gps_lat, gps_lng) VALUES
  ('ACC-2019-004521', 'Fillemon Nghidishange',  '04040404040',  'Katutura',        'R1', '900100', '01', 'Conlog',  'BEC23',   245.80,    0.00, 'Active',       '+264 81 200 1001', '24 Clemence Kapuuo St, Katutura, Windhoek',      -22.5200, 17.0500),
  ('ACC-2020-001287', 'Helena Shilongo',         '04040404041',  'Khomasdal',       'R1', '900100', '01', 'Hexing',  'HXE310',  120.50,    0.00, 'Active',       '+264 81 200 1002', '8 Lazarett St, Khomasdal, Windhoek',              -22.5400, 17.0600),
  ('ACC-2018-007834', 'Paulus Shivute',          '04040404042',  'Oshakati',        'R1', '900100', '02', 'Landis',  'E350',      0.00,  450.00, 'Arrears',      '+264 81 200 1003', '15 Main Road, Oshakati',                          -17.7870, 15.6880),
  ('ACC-2021-002156', 'Ndahafa Angula',          '04040404043',  'Kleine Kuppe',    'R2', '900200', '01', 'Conlog',  'BEC44',   580.20,    0.00, 'Active',       '+264 81 200 1004', '42 Nelson Mandela Ave, Kleine Kuppe, Windhoek',   -22.5900, 17.0900),
  ('ACC-2017-009012', 'Johannes Kalimbo',        '04040404044',  'Walvis Bay',      'R1', '900100', '01', 'Itron',   'ACE6000', 312.40,    0.00, 'Active',       '+264 81 200 1005', '7 Atlantic St, Walvis Bay',                       -22.9570, 14.5050),
  ('ACC-2022-000345', 'Frieda Nghifikwa',        '04040404045',  'Rundu',           'R1', '900100', '03', 'Hexing',  'HXE310',   45.00,  820.00, 'Arrears',      '+264 81 200 1006', '33 Kaisosi Road, Rundu',                          -17.9250, 19.7650),
  ('ACC-2019-006789', 'Samuel Amupadhi',         '04040404046',  'Olympia',         'C1', '900300', '01', 'Landis',  'E650',   1250.00,    0.00, 'Active',       '+264 81 200 1007', '12 Sam Nujoma Dr, Olympia, Windhoek',             -22.5780, 17.0830),
  ('ACC-2020-003456', 'Martha Hangula',          '04040404047',  'Ongwediva',       'R1', '900100', '01', 'Conlog',  'BEC23',    88.30,    0.00, 'Active',       '+264 81 200 1008', '5 Church Street, Ongwediva',                      -17.7810, 15.7670),
  ('ACC-2016-011234', 'Thomas Kashihakumwa',     '04040404048',  'Swakopmund',      'R2', '900200', '02', 'Itron',   'SL7000',  420.60,    0.00, 'Active',       '+264 81 200 1009', '19 Libertina Amathila Ave, Swakopmund',            -22.6840, 14.5280),
  ('ACC-2023-000678', 'Loide Nambinga',          '04040404049',  'Katima Mulilo',   'R1', '900100', '01', 'Hexing',  'HXE115',    0.00, 1200.00, 'Suspended',    '+264 81 200 1010', '28 Ngoma Road, Katima Mulilo',                    -17.4960, 25.0120),
  ('ACC-2021-005432', 'Erastus Shipanga',        '04040404050',  'Windhoek Central','C1', '900300', '01', 'Landis',  'E650',   2100.00,    0.00, 'Active',       '+264 81 200 1011', '3 Fidel Castro St, Windhoek Central',             -22.5600, 17.0830),
  ('ACC-2018-008765', 'Peneyambeko Iithete',     '04040404051',  'Katutura',        'R1', '900100', '02', 'Conlog',  'BEC23',    15.00,  180.00, 'Arrears',      '+264 81 200 1012', '61 Eveline St, Katutura, Windhoek',               -22.5230, 17.0520);

-- ---------------------------------------------------------------------------
-- 5. Transactions (10) — recent vending activity
-- ---------------------------------------------------------------------------
INSERT INTO transactions (reference, customer_id, meter_no, amount, kwh, token, operator_id, vendor_id, status, type, breakdown, created_at) VALUES
  ('TXN-20260312080112', 1,  '04040404040', 150.00,  78.42, '1234-5678-9012-3456-7890', 3, 1, 'Success', 'Vend',
    '{"vat": 19.57, "fixedCharge": 8.50, "relLevy": 2.40, "arrears": 0.00, "units": 78.42}',
    '2026-03-12 08:01:12'),

  ('TXN-20260312081530', 2,  '04040404041', 200.00, 104.56, '2345-6789-0123-4567-8901', 3, 1, 'Success', 'Vend',
    '{"vat": 26.09, "fixedCharge": 8.50, "relLevy": 2.40, "arrears": 0.00, "units": 104.56}',
    '2026-03-12 08:15:30'),

  ('TXN-20260312090045', 3,  '04040404042', 500.00, 195.20, '3456-7890-1234-5678-9012', 5, 2, 'Arrears', 'Vend',
    '{"vat": 65.22, "fixedCharge": 8.50, "relLevy": 2.40, "arrears": 150.00, "units": 195.20}',
    '2026-03-12 09:00:45'),

  ('TXN-20260312093200', 5,  '04040404044', 100.00,  52.18, '4567-8901-2345-6789-0123', 3, 3, 'Success', 'Vend',
    '{"vat": 13.04, "fixedCharge": 8.50, "relLevy": 2.40, "arrears": 0.00, "units": 52.18}',
    '2026-03-12 09:32:00'),

  ('TXN-20260312100115', 7,  '04040404046', 800.00, 310.45, '5678-9012-3456-7890-1234', 5, 1, 'Success', 'Vend',
    '{"vat": 104.35, "fixedCharge": 8.50, "relLevy": 2.40, "arrears": 0.00, "units": 310.45}',
    '2026-03-12 10:01:15'),

  ('TXN-20260312103500', 8,  '04040404047',  50.00,  26.09, '6789-0123-4567-8901-2345', 3, 2, 'Success', 'Vend',
    '{"vat": 6.52, "fixedCharge": 8.50, "relLevy": 2.40, "arrears": 0.00, "units": 26.09}',
    '2026-03-12 10:35:00'),

  ('TXN-20260312111200', 4,  '04040404043', 300.00, 134.88, '7890-1234-5678-9012-3456', 5, 3, 'Success', 'Vend',
    '{"vat": 39.13, "fixedCharge": 8.50, "relLevy": 2.40, "arrears": 0.00, "units": 134.88}',
    '2026-03-12 11:12:00'),

  ('TXN-20260312120030', 9,  '04040404048', 250.00, 112.40, '8901-2345-6789-0123-4567', 3, 5, 'Success', 'Vend',
    '{"vat": 32.61, "fixedCharge": 8.50, "relLevy": 2.40, "arrears": 0.00, "units": 112.40}',
    '2026-03-12 12:00:30'),

  ('TXN-20260312130045', 12, '04040404051', 350.00, 128.60, '9012-3456-7890-1234-5678', 5, 4, 'Arrears', 'Vend',
    '{"vat": 45.65, "fixedCharge": 8.50, "relLevy": 2.40, "arrears": 100.00, "units": 128.60}',
    '2026-03-12 13:00:45'),

  ('TXN-20260311170000', 6,  '04040404045', 200.00,   0.00, NULL,                        2, 4, 'Failed',  'Vend',
    '{"vat": 0.00, "fixedCharge": 0.00, "relLevy": 0.00, "arrears": 0.00, "units": 0.00}',
    '2026-03-11 17:00:00');

-- ---------------------------------------------------------------------------
-- 6. System Config
-- ---------------------------------------------------------------------------
INSERT INTO system_config (config_key, config_value) VALUES
  ('vatRate',           '15'),
  ('fixedCharge',       '8.50'),
  ('relLevy',           '2.40'),
  ('minPurchase',       '10'),
  ('arrearsMode',       'Auto-deduct on vend'),
  ('arrearsThreshold',  '500');

-- ---------------------------------------------------------------------------
-- 7. Audit Log (8 entries)
-- ---------------------------------------------------------------------------
INSERT INTO audit_log (event, detail, username, type, ip_address, created_at) VALUES
  ('User Login',         'System Admin logged in successfully',                             'admin',    'login',    '192.168.1.10',  '2026-03-12 08:15:00'),
  ('User Login',         'Jonas Amupolo logged in successfully',                            'jonas.a',  'login',    '192.168.1.25',  '2026-03-12 08:00:00'),
  ('Vend Token',         'Vend N$150.00 to meter 04040404040 — 78.42 kWh (TXN-20260312080112)', 'jonas.a',  'vend',     '192.168.1.25',  '2026-03-12 08:01:12'),
  ('Vend Token',         'Vend N$200.00 to meter 04040404041 — 104.56 kWh (TXN-20260312081530)','jonas.a',  'vend',     '192.168.1.25',  '2026-03-12 08:15:30'),
  ('Vend Token',         'Vend N$500.00 to meter 04040404042 — arrears deduction N$150 (TXN-20260312090045)', 'petrus.h', 'vend',  '192.168.1.32', '2026-03-12 09:00:45'),
  ('Customer Created',   'New customer Loide Nambinga (ACC-2023-000678) added to system',   'admin',    'create',   '192.168.1.10',  '2026-03-11 14:30:00'),
  ('Tariff Updated',     'R1 Block 4 rate updated from 2.7500 to 2.8120',                  'admin',    'update',   '192.168.1.10',  '2026-03-10 09:00:00'),
  ('System Config',      'arrearsThreshold changed from 300 to 500',                       'admin',    'system',   '192.168.1.10',  '2026-03-09 11:00:00');
