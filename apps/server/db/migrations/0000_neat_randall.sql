CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`venue_id` text NOT NULL,
	`at` integer NOT NULL,
	`recorded_at` integer NOT NULL,
	`type` text NOT NULL,
	`ticket_id` text,
	`table_id` text,
	`actor_kind` text,
	`actor_id` text,
	`payload` text NOT NULL,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_venue_seq` ON `events` (`venue_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_venue_at` ON `events` (`venue_id`,`at`);--> statement-breakpoint
CREATE TABLE `table_status_log` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`venue_id` text NOT NULL,
	`table_id` text NOT NULL,
	`status` text NOT NULL,
	`from_at` integer NOT NULL,
	`until_at` integer,
	`occupant_ticket_id` text,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`table_id`) REFERENCES `tables`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "span_moves_forward" CHECK(until_at IS NULL OR until_at >= from_at),
	CONSTRAINT "span_status_is_declared" CHECK(status IN ('DISABLED', 'FREE', 'HELD', 'OCCUPIED', 'OCCUPIED_UNKNOWN', 'TURNOVER', 'NEEDS_CHECK'))
);
--> statement-breakpoint
CREATE INDEX `status_log_venue_table` ON `table_status_log` (`venue_id`,`table_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `one_open_span_per_table` ON `table_status_log` (`table_id`) WHERE until_at IS NULL;--> statement-breakpoint
CREATE TABLE `tables` (
	`id` text PRIMARY KEY NOT NULL,
	`venue_id` text NOT NULL,
	`zone_id` text,
	`token` text NOT NULL,
	`label` text NOT NULL,
	`capacity` integer NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`admin_rank` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text NOT NULL,
	`status_since` integer NOT NULL,
	`verified_free_at` integer,
	`occupant_ticket_id` text,
	`disable_after_current` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`zone_id`) REFERENCES `zones`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "capacity_is_positive" CHECK(capacity >= 1),
	CONSTRAINT "table_status_is_declared" CHECK(status IN ('DISABLED', 'FREE', 'HELD', 'OCCUPIED', 'OCCUPIED_UNKNOWN', 'TURNOVER', 'NEEDS_CHECK')),
	CONSTRAINT "unmanaged_table_is_disabled" CHECK(enabled OR status = 'DISABLED'),
	CONSTRAINT "disabled_table_has_no_reservation" CHECK(NOT disable_after_current OR status <> 'DISABLED'),
	CONSTRAINT "occupant_only_when_taken" CHECK(occupant_ticket_id IS NULL OR status IN ('HELD', 'OCCUPIED', 'OCCUPIED_UNKNOWN', 'NEEDS_CHECK'))
);
--> statement-breakpoint
CREATE INDEX `tables_venue` ON `tables` (`venue_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tables_token` ON `tables` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `tables_venue_label` ON `tables` (`venue_id`,`label`);--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`venue_id` text NOT NULL,
	`client_token_hash` text,
	`code` text NOT NULL,
	`party_size` integer NOT NULL,
	`required_tags` text DEFAULT '[]' NOT NULL,
	`state` text NOT NULL,
	`priority_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`table_id` text,
	`called_at` integer,
	`hold_deadline` integer,
	`hold_reminded_at` integer,
	`extensions` integer DEFAULT 0 NOT NULL,
	`passes` integer DEFAULT 0 NOT NULL,
	`no_shows` integer DEFAULT 0 NOT NULL,
	`conflict_priority` integer DEFAULT false NOT NULL,
	`seated_at` integer,
	`ended_at` integer,
	`end_reason` text,
	`pause_deadline` integer,
	`paused_since` integer,
	`paused_total` integer DEFAULT 0 NOT NULL,
	`last_seen_at` integer NOT NULL,
	`has_notification_channel` integer DEFAULT false NOT NULL,
	`still_here_asked_at` integer,
	`still_here_answered_at` integer,
	`time_limit_noticed_at` integer,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`table_id`) REFERENCES `tables`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "party_size_is_positive" CHECK(party_size >= 1),
	CONSTRAINT "ticket_state_is_declared" CHECK(state IN ('WAITING', 'PAUSED', 'CALLED', 'SEATED', 'DONE', 'CANCELLED', 'NO_SHOW', 'EXPIRED')),
	CONSTRAINT "end_reason_is_declared" CHECK(end_reason IS NULL OR end_reason IN ('checked_out', 'staff_checkout', 'auto_release', 'user_cancel', 'staff_cancel', 'venue_closed', 'no_show', 'abandoned', 'pause_expired', 'max_age')),
	CONSTRAINT "assigned_has_table" CHECK((NOT (state IN ('CALLED', 'SEATED')) OR (table_id IS NOT NULL))),
	CONSTRAINT "terminal_holds_no_table" CHECK((NOT (state IN ('DONE', 'CANCELLED', 'NO_SHOW', 'EXPIRED')) OR (table_id IS NULL))),
	CONSTRAINT "held_table_has_deadline" CHECK((NOT (state = 'CALLED') OR (hold_deadline IS NOT NULL AND called_at IS NOT NULL))),
	CONSTRAINT "state_timestamps_are_set" CHECK((NOT (state = 'SEATED') OR (seated_at IS NOT NULL)) AND (NOT (state = 'PAUSED') OR (pause_deadline IS NOT NULL AND paused_since IS NOT NULL)) AND (NOT (state IN ('DONE', 'CANCELLED', 'NO_SHOW', 'EXPIRED')) OR (ended_at IS NOT NULL AND end_reason IS NOT NULL))),
	CONSTRAINT "notices_are_scoped" CHECK((NOT (state <> 'PAUSED') OR (paused_since IS NULL)) AND (NOT (state <> 'CALLED') OR (hold_reminded_at IS NULL)) AND (NOT (state <> 'SEATED') OR (still_here_asked_at IS NULL AND still_here_answered_at IS NULL AND time_limit_noticed_at IS NULL))),
	CONSTRAINT "end_reason_matches_state" CHECK(end_reason IS NULL OR (end_reason = 'checked_out' AND state = 'DONE') OR (end_reason = 'staff_checkout' AND state = 'DONE') OR (end_reason = 'auto_release' AND state = 'DONE') OR (end_reason = 'user_cancel' AND state = 'CANCELLED') OR (end_reason = 'staff_cancel' AND state = 'CANCELLED') OR (end_reason = 'venue_closed' AND state = 'CANCELLED') OR (end_reason = 'no_show' AND state = 'NO_SHOW') OR (end_reason = 'abandoned' AND state = 'EXPIRED') OR (end_reason = 'pause_expired' AND state = 'EXPIRED') OR (end_reason = 'max_age' AND state = 'EXPIRED'))
);
--> statement-breakpoint
CREATE INDEX `tickets_venue_state` ON `tickets` (`venue_id`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `one_ticket_per_table` ON `tickets` (`table_id`) WHERE table_id IS NOT NULL AND state IN ('CALLED', 'SEATED');--> statement-breakpoint
CREATE UNIQUE INDEX `unique_active_codes` ON `tickets` (`venue_id`,`code`) WHERE NOT state IN ('DONE', 'CANCELLED', 'NO_SHOW', 'EXPIRED');--> statement-breakpoint
CREATE TABLE `venues` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`timezone` text DEFAULT 'Asia/Tokyo' NOT NULL,
	`locale` text DEFAULT 'ja' NOT NULL,
	`managed_schedule` text,
	`status` text DEFAULT 'active' NOT NULL,
	`policy` text NOT NULL,
	`operating` integer DEFAULT false NOT NULL,
	`join_open` integer DEFAULT false NOT NULL,
	`closes_at` integer,
	`clock_at` integer,
	`next_code_seq` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "join_requires_operating" CHECK(NOT join_open OR operating),
	CONSTRAINT "next_code_seq_is_not_negative" CHECK(next_code_seq >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `venues_slug` ON `venues` (`slug`);--> statement-breakpoint
CREATE TABLE `zones` (
	`id` text PRIMARY KEY NOT NULL,
	`venue_id` text NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `zones_venue` ON `zones` (`venue_id`);