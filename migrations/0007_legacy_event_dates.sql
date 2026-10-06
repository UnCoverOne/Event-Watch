-- Older watches stored display dates such as "Oct 8, 2026". Backfill sortable
-- timestamps so these records participate in date ordering and past-event filters.
UPDATE events SET starts_at = strftime('%Y-%m-%dT%H:%M:%fZ', event_date)
WHERE starts_at IS NULL AND event_date IS NOT NULL AND strftime('%Y-%m-%d', event_date) IS NOT NULL;
UPDATE events SET starts_at = printf('%04d-%02d-%02dT00:00:00.000Z',
  CAST(substr(event_date, -4) AS INTEGER),
  CASE substr(event_date, 1, 3)
    WHEN 'Jan' THEN 1 WHEN 'Feb' THEN 2 WHEN 'Mar' THEN 3 WHEN 'Apr' THEN 4
    WHEN 'May' THEN 5 WHEN 'Jun' THEN 6 WHEN 'Jul' THEN 7 WHEN 'Aug' THEN 8
    WHEN 'Sep' THEN 9 WHEN 'Oct' THEN 10 WHEN 'Nov' THEN 11 WHEN 'Dec' THEN 12 END,
  CAST(trim(substr(event_date, instr(event_date, ' ') + 1, instr(event_date, ',') - instr(event_date, ' ') - 1)) AS INTEGER))
WHERE starts_at IS NULL
  AND substr(event_date, 1, 3) IN ('Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec')
  AND instr(event_date, ',') BETWEEN 6 AND 8
  AND CAST(substr(event_date, -4) AS INTEGER) BETWEEN 2000 AND 2200
  AND CAST(trim(substr(event_date, instr(event_date, ' ') + 1, instr(event_date, ',') - instr(event_date, ' ') - 1)) AS INTEGER) BETWEEN 1 AND 31;
