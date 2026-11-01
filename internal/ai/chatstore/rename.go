package chatstore

import "time"

// retryRename calls rename and retries sharing violations up to 5 times
// with 20, 40, 80, 160 and 320 ms backoff. Used on Windows; testable with
// injected functions.
func retryRename(rename func(string, string) error, oldPath, newPath string, sleep func(time.Duration)) error {
	delay := 20 * time.Millisecond
	var err error
	for attempt := 0; attempt <= 5; attempt++ {
		if err = rename(oldPath, newPath); err == nil || !isSharingViolationErr(err) {
			return err
		}
		if attempt < 5 {
			sleep(delay)
			delay *= 2
		}
	}
	return err
}
