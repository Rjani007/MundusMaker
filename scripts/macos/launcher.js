// Executed by macOS's built-in JavaScript for Automation, not by Node.
// AppKit provides the menu bar; NSTask owns only the server this app starts.
ObjC.import('Cocoa');

function run(argv) {
  try { launch(argv); }
  catch (err) {
    var dialog = $.NSAlert.alloc.init;
    dialog.messageText = $('MundusMaker could not start');
    dialog.informativeText = $(String(err) + '\nPlease include this message when reporting startup trouble.');
    dialog.addButtonWithTitle($('OK'));
    $.NSApplication.sharedApplication.activateIgnoringOtherApps(true); dialog.runModal;
  }
}
function launch(argv) {
  if (!argv || !argv[0]) throw new Error('The app folder was not supplied. Open MundusMaker.app from the complete extracted download.');
  var appRoot = argv[0];
  var fm = $.NSFileManager.defaultManager;
  var runtime = argv[1];
  if (!runtime || !fm.isExecutableFileAtPath($(runtime))) throw new Error('The bundled runtime could not be found for this Mac. Extract the complete download again, then open MundusMaker.app.');
  var support = ObjC.unwrap($.NSHomeDirectory()) + '/Library/Application Support/MundusMaker';
  var logs = ObjC.unwrap($.NSHomeDirectory()) + '/Library/Logs/MundusMaker';
  function ensureDirectory(folder) {
    // JXA's JavaScript null becomes NSNull, not Objective-C nil. Foundation
    // calls count on the attributes dictionary, so an NSNull crashes startup.
    var error = $();
    if (!fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(folder), true, $.NSDictionary.dictionary, error)) {
      var reason = error.isNil() ? 'Check that your account can write to this folder.' : ObjC.unwrap(error.localizedDescription);
      throw new Error('Could not prepare ' + folder + '\n' + reason);
    }
  }
  ensureDirectory(support);
  ensureDirectory(logs);
  var logPath = logs + '/server.log';
  if (!fm.fileExistsAtPath($(logPath)) && !fm.createFileAtPathContentsAttributes($(logPath), $.NSData.data, $.NSDictionary.dictionary)) {
    throw new Error('Could not create the startup log at ' + logPath + '. Check this folder’s permissions.');
  }
  var log = $.NSFileHandle.fileHandleForWritingAtPath($(logPath));
  if (log.isNil()) throw new Error('Could not open the startup log for writing: ' + logPath);
  log.seekToEndOfFile;
  var environment = $.NSMutableDictionary.dictionaryWithDictionary($.NSProcessInfo.processInfo.environment);
  environment.setObjectForKey($(support), $('MUNDUSMAKER_CONFIG_DIR'));
  // A GUI launch should open the browser even if a shell profile disabled it.
  ['MUNDUSMAKER_NO_OPEN', 'TOMEWEAVER_NO_OPEN', 'LOREWEAVE_NO_OPEN'].forEach(function (key) { environment.removeObjectForKey($(key)); });
  var task = $.NSTask.alloc.init;
  task.launchPath = $(runtime);
  task.arguments = $([appRoot + '/server.js']);
  task.currentDirectoryPath = $(support);
  task.environment = environment;
  task.standardOutput = log;
  task.standardError = log;
  task.standardInput = $.NSFileHandle.fileHandleWithNullDevice;

  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(1); // accessory: a menu bar item, no empty Dock window
  var reportedExit = false;
  function openUrl() {
    // Match the server's port precedence, including legacy config names.
    var port = Number(ObjC.unwrap(environment.objectForKey($('PORT'))) || 0);
    if (!port) {
      ['mundusmaker', 'tomeweaver', 'loreweave'].some(function (name) {
        try {
          var json = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError($(support + '/' + name + '.config.json'), $.NSUTF8StringEncoding, $()));
          if (!json) return false;
          port = Number(JSON.parse(json).port || 4870); return true;
        } catch (_) { return false; }
      });
    }
    $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString($('http://localhost:' + (port || 4870))));
  }
  function alert(title, message) {
    var dialog = $.NSAlert.alloc.init;
    dialog.messageText = $(title); dialog.informativeText = $(message);
    dialog.addButtonWithTitle($('OK'));
    app.activateIgnoringOtherApps(true); dialog.runModal;
  }
  ObjC.registerSubclass({
    name: 'MundusMakerMenuDelegate', superclass: 'NSObject', protocols: ['NSApplicationDelegate'],
    methods: {
      'openBrowser:': { types: ['void', ['id']], implementation: openUrl },
      'showSupport:': { types: ['void', ['id']], implementation: function () { $.NSWorkspace.sharedWorkspace.openURL($.NSURL.fileURLWithPath($(support))); } },
      'showLog:': { types: ['void', ['id']], implementation: function () { $.NSWorkspace.sharedWorkspace.openURL($.NSURL.fileURLWithPath($(logPath))); } },
      'quit:': { types: ['void', ['id']], implementation: function () {
        if (task.running) {
          var dialog = $.NSAlert.alloc.init;
          dialog.messageText = $('Quit MundusMaker?');
          dialog.informativeText = $('Wait for the Saved indicator in your browser before quitting. This stops the local server; your saved worlds stay on disk.');
          dialog.addButtonWithTitle($('Cancel')); dialog.addButtonWithTitle($('Quit MundusMaker'));
          app.activateIgnoringOtherApps(true);
          if (Number(dialog.runModal) !== 1001) return;
          task.terminate;
        }
        app.terminate($());
      } },
      'checkServer:': { types: ['void', ['id']], implementation: function () {
        if (reportedExit || task.running) return;
        reportedExit = true;
        // The server's exit codes: 0 = it quit (Settings > Quit) or opened the
        // same MundusMaker already running; 3 = a different or older MundusMaker
        // holds the port; 4 = another program holds it.
        var code = Number(task.terminationStatus);
        if (code === 3) alert('Another MundusMaker is already running', 'A different or older copy of MundusMaker is using the same port, so this one did not start. Quit the other copy first (MM > Quit MundusMaker in its menu bar, or close its window), then open MundusMaker again.');
        else if (code === 4) alert('MundusMaker could not start', 'Another program is using MundusMaker’s port. Close that program, then open MundusMaker again.');
        else if (code !== 0) {
          // keep the menu so the startup log is one click away
          alert('MundusMaker could not start', 'Use the MM menu to open the startup log and include it when reporting the problem. Your saved worlds have not been removed.');
          return;
        }
        app.terminate($());
      } },
      'applicationShouldHandleReopen:hasVisibleWindows:': { implementation: function () { openUrl(); return true; } },
      'applicationWillTerminate:': { types: ['void', ['id']], implementation: function () { if (task.running) task.terminate; } },
    },
  });
  var delegate = $.MundusMakerMenuDelegate.alloc.init;
  app.delegate = delegate;
  var statusItem = $.NSStatusBar.systemStatusBar.statusItemWithLength(-1);
  statusItem.button.title = $('MM'); statusItem.button.toolTip = $('MundusMaker');
  var menu = $.NSMenu.alloc.init;
  menu.autoenablesItems = false;
  function item(title, action) {
    var row = $.NSMenuItem.alloc.init;
    row.title = $(title); row.keyEquivalent = $('');
    if (action) row.action = action;
    row.target = delegate; menu.addItem(row); return row;
  }
  var serverState = item('MundusMaker is running locally'); serverState.enabled = false;
  menu.addItem($.NSMenuItem.separatorItem);
  item('Open MundusMaker', 'openBrowser:');
  item('Open app support folder', 'showSupport:');
  item('Open startup log', 'showLog:');
  menu.addItem($.NSMenuItem.separatorItem);
  item('Quit MundusMaker', 'quit:');
  statusItem.menu = menu;
  try { task.launch; }
  catch (err) { alert('MundusMaker could not start', String(err) + '\nSee README-FIRST.html for startup help.'); return; }
  var timer = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(2, delegate, 'checkServer:', $(), true);
  app.run;
}
