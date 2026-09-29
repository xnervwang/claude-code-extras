// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The single list of patch targets, in the order they are applied.
 *
 * Both the extension entry point and the uninstall hook read the list from here. Keeping it in one place is
 * deliberate: when these were two separate hardcoded arrays, adding the host target to one of them and forgetting
 * the other left an orphaned patch behind on uninstall.
 */
module.exports = [require('./webview'), require('./host'), require('./logo')];
