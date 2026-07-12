// This file is intentionally left empty.
//
// The original pre-key-manager.js provided a PreKeyManager class used
// exclusively by the old Utils/auth-utils.js to serialize pre-key
// read/validate/delete operations through a PQueue.
//
// It is no longer imported or used after replacing auth-utils.js with
// the lighter-weight version (no PQueue/Mutex/AsyncLocalStorage).
//
// You can safely delete this file entirely instead of using this stub.
// It's kept here only so that repositories/build tools expecting the
// file path to exist won't break.
