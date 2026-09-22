CREATE TABLE `command_log` (
	`venue_id` text NOT NULL,
	`key` text NOT NULL,
	`at` integer NOT NULL,
	`command_type` text NOT NULL,
	`ok` integer NOT NULL,
	`rejection_code` text,
	`ticket_id` text,
	PRIMARY KEY(`venue_id`, `key`),
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "command_type_is_declared" CHECK(command_type IN ('JOIN', 'CANCEL', 'PAUSE', 'READY', 'EXTEND', 'PASS', 'CHECK_IN', 'CHECK_OUT', 'SWAP_TABLE', 'CHECK_IN_EARLY', 'WALK_IN', 'REPORT_TAKEN', 'REPORT_IN_USE', 'CONFIRM_FREE', 'STILL_HERE', 'CHANGE_PARTY_SIZE', 'HEARTBEAT', 'OPEN', 'CLOSE', 'RELEASE_ALL', 'DISABLE_TABLE', 'ENABLE_TABLE')),
	CONSTRAINT "rejection_code_is_declared" CHECK(rejection_code IS NULL OR rejection_code IN ('TICKET_NOT_FOUND', 'TABLE_NOT_FOUND', 'TICKET_ALREADY_EXISTS', 'PARTY_SIZE_INVALID', 'PARTY_TOO_SMALL', 'PARTY_TOO_LARGE', 'QUEUE_FULL', 'JOIN_CLOSED', 'NOT_ALLOWED_IN_STATE', 'BLOCKED_BY_GUARD', 'GUARD_NOT_IMPLEMENTED', 'REASON_REQUIRED', 'STAFF_ONLY', 'FORBIDDEN', 'ACTOR_MISMATCH', 'NO_CODE_AVAILABLE', 'CLOCK_WENT_BACKWARD', 'INVARIANT_VIOLATED')),
	CONSTRAINT "rejection_matches_outcome" CHECK((ok AND rejection_code IS NULL) OR (NOT ok AND rejection_code IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `command_log_at` ON `command_log` (`at`);