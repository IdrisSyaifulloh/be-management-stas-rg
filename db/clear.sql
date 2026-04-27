-- Clear all data from database (in order to avoid FK conflicts)
-- Run this before re-seeding if you want clean database

DELETE FROM dashboard_reminder_logs;
DELETE FROM dashboard_warning_reviews;
DELETE FROM notification_dispatch_logs;
DELETE FROM notifications;
DELETE FROM audit_logs;
DELETE FROM attendance_records;
DELETE FROM student_access_locks;
DELETE FROM research_board_task_comments;
DELETE FROM research_board_task_attachments;
DELETE FROM research_board_task_subtasks;
DELETE FROM research_board_task_assignees;
DELETE FROM research_board_tasks;
DELETE FROM logbook_comments;
DELETE FROM logbook_entries;
DELETE FROM certificate_requests;
DELETE FROM letter_database;
DELETE FROM letter_categories;
DELETE FROM letter_requests;
DELETE FROM leave_requests;
DELETE FROM board_access;
DELETE FROM research_memberships;
DELETE FROM research_milestones;
DELETE FROM research_projects;
DELETE FROM lecturers;
DELETE FROM students;
DELETE FROM users;

-- Optional: Reset sequences if needed (for SERIAL columns)
-- Uncomment if you use SERIAL/BIGSERIAL and want to reset IDs

-- SELECT setval('research_milestones_id_seq', 1, false);
-- SELECT setval('research_memberships_id_seq', 1, false);
-- SELECT setval('board_access_id_seq', 1, false);
-- SELECT setval('logbook_comments_id_seq', 1, false);
