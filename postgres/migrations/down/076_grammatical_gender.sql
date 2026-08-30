BEGIN;

DELETE FROM onboarding_fields WHERE field_key = 'grammatical_gender';
DELETE FROM profile_field_definitions WHERE field_key = 'grammatical_gender';
DELETE FROM schema_migrations WHERE version = '076_grammatical_gender';

COMMIT;
