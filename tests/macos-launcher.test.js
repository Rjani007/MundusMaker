'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/macos/launcher.js'), 'utf8');

// This models the Cocoa bridge's relevant contracts, not a macOS runtime.
// In particular JS null is NSNull, whose missing count selector caused the
// reported crash. Native nil ($()) and real dictionaries must be distinguished.
function cocoa(options = {}, code = source) {
  const calls = { alerts: [], directories: [], urls: [], launched: 0, terminated: 0, appTerminated: 0, ran: 0, menu: [] };
  const nil = () => ({ nativeNil: true, isNil() { return this.nativeNil; } });
  const $ = function(value) { return arguments.length ? value : nil(); };
  const alloc = factory => ({ get alloc() { return { get init() { return factory(); } }; } });
  const dictionary = () => ({ dictionary: true });
  const attributes = value => {
    if (value === null) throw new Error('exception raised by object: -[NSNull count]: unrecognized selector sent to instance');
    assert.equal(value.dictionary, true, 'Foundation attributes must be a dictionary');
  };
  const nativeNil = value => assert.equal(value?.nativeNil, true, 'pass Objective-C nil, not JS null');
  $.NSDictionary = { get dictionary() { return dictionary(); } };
  $.NSFileManager = { defaultManager: {
    isExecutableFileAtPath: () => !options.missingRuntime,
    createDirectoryAtPathWithIntermediateDirectoriesAttributesError(folder, recursive, attrs, error) {
      attributes(attrs); nativeNil(error); assert.equal(recursive, true); calls.directories.push(folder);
      if (options.directoryFailure) { error.nativeNil = false; error.localizedDescription = 'Permission denied'; return false; }
      return true;
    },
    fileExistsAtPath: () => false,
    createFileAtPathContentsAttributes(file, contents, attrs) { attributes(attrs); return !options.logFailure; },
  } };
  $.NSHomeDirectory = () => '/Users/Tester';
  $.NSData = { data: {} };
  $.NSFileHandle = {
    fileHandleForWritingAtPath: () => options.missingLogHandle ? nil() : { isNil: () => false, seekToEndOfFile: 0 },
    fileHandleWithNullDevice: {},
  };
  $.NSProcessInfo = { processInfo: { environment: {} } };
  const env = new Map(Object.entries(options.environment || {}));
  $.NSMutableDictionary = { dictionaryWithDictionary: () => ({
    setObjectForKey: (value, key) => env.set(key, value), removeObjectForKey: key => env.delete(key), objectForKey: key => env.get(key) ?? nil(),
  }) };
  $.NSTask = alloc(() => {
    const task = { running: false, terminationStatus: 0,
      get launch() { calls.launched++; this.running = true; return undefined; },
      get terminate() { calls.terminated++; this.running = false; return undefined; },
    }; calls.task = task; return task;
  });
  const app = { setActivationPolicy() {}, activateIgnoringOtherApps() {}, get run() { calls.ran++; }, terminate(value) { nativeNil(value); calls.appTerminated++; } };
  $.NSApplication = { sharedApplication: app };
  $.NSAlert = alloc(() => {
    const alert = { addButtonWithTitle() {}, get runModal() { calls.alerts.push({ title: this.messageText, message: this.informativeText }); return options.quitAnswer ?? 1000; } };
    return alert;
  });
  $.NSString = { stringWithContentsOfFileEncodingError(file, encoding, error) { nativeNil(error); return options.config ? JSON.stringify(options.config) : nil(); } };
  $.NSUTF8StringEncoding = 4;
  $.NSURL = { URLWithString: x => x, fileURLWithPath: x => x };
  $.NSWorkspace = { sharedWorkspace: { openURL: x => calls.urls.push(x) } };
  $.NSStatusBar = { systemStatusBar: { statusItemWithLength: () => ({ button: {} }) } };
  $.NSMenu = alloc(() => ({ addItem: x => calls.menu.push(x) }));
  $.NSMenuItem = { ...alloc(() => ({})), separatorItem: {} };
  // Spreading would evaluate the allocator getter once; each .init still
  // creates its own row, just like the JXA bridge.
  $.NSTimer = { scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(interval, delegate, selector, info) { nativeNil(info); return {}; } };
  const ObjC = {
    import() {}, unwrap: x => x?.nativeNil ? null : x,
    registerSubclass(definition) { calls.methods = definition.methods; $[definition.name] = alloc(() => ({})); },
  };
  const context = vm.createContext({ $, ObjC });
  vm.runInContext(code, context);
  context.run(['/Applications/MundusMaker.app/Contents/Resources/app', '/bundled/node']);
  calls.environment = env;
  return calls;
}

test('Mac startup passes dictionaries and native nil through every Cocoa call', () => {
  const result = cocoa();
  assert.deepEqual(result.alerts, []); assert.equal(result.launched, 1); assert.equal(result.ran, 1);
  assert.equal(result.directories.length, 2);
  assert.equal(result.task.currentDirectoryPath, '/Users/Tester/Library/Application Support/MundusMaker');
  assert.equal(result.task.launchPath, '/bundled/node');
  assert.equal(result.task.arguments[0], '/Applications/MundusMaker.app/Contents/Resources/app/server.js');
  assert.equal(result.menu[0].action, undefined); assert.equal(result.menu[0].enabled, false);
  assert.equal(result.menu.find(row => row.title === 'Open MundusMaker').action, 'openBrowser:');
  result.methods['openBrowser:'].implementation();
  assert.equal(result.urls[0], 'http://localhost:4870');
});
test('regression fixture reproduces the tester’s exact NSNull count error with the old attributes call', () => {
  const old = source.replace('$(folder), true, $.NSDictionary.dictionary, error', '$(folder), true, null, null');
  const result = cocoa({}, old);
  assert.match(result.alerts[0].message, /-\[NSNull count\]/); assert.equal(result.launched, 0);
});
test('Mac startup explains filesystem failures before attempting to start the server', () => {
  for (const [options, message] of [
    [{ directoryFailure: true }, /Could not prepare.*Application Support[\s\S]*Permission denied/],
    [{ logFailure: true }, /Could not create the startup log/],
    [{ missingLogHandle: true }, /Could not open the startup log/],
    [{ missingRuntime: true }, /bundled runtime could not be found/],
  ]) {
    const result = cocoa(options);
    assert.equal(result.launched, 0); assert.match(result.alerts[0].message, message);
  }
});
test('Mac menu honours saved ports and quits only its owned task after confirmation', () => {
  const cancel = cocoa({ config: { port: 4981 }, environment: { MUNDUSMAKER_NO_OPEN: '1' } });
  cancel.methods['openBrowser:'].implementation(); assert.equal(cancel.urls[0], 'http://localhost:4981');
  assert.equal(cancel.environment.has('MUNDUSMAKER_NO_OPEN'), false);
  cancel.methods['quit:'].implementation(); assert.equal(cancel.terminated, 0);
  const quit = cocoa({ quitAnswer: 1001, environment: { PORT: '4990' } });
  quit.methods['openBrowser:'].implementation(); assert.equal(quit.urls[0], 'http://localhost:4990');
  quit.methods['quit:'].implementation(); assert.equal(quit.terminated, 1); assert.equal(quit.appTerminated, 1);
});
test('Mac menu closes when its server quits or hands off, and explains a busy port', () => {
  for (const [status, message, closes] of [
    [0, null, true], // Settings > Quit, or the same MundusMaker was already running and was opened
    [3, /different or older copy of MundusMaker/, true],
    [4, /Another program is using/, true],
    [1, /open the startup log/, false], // the menu stays so the log is one click away
  ]) {
    const result = cocoa();
    result.task.running = false; result.task.terminationStatus = status;
    result.methods['checkServer:'].implementation();
    if (message) assert.match(result.alerts[0].message, message, `exit ${status}`); else assert.deepEqual(result.alerts, [], `exit ${status}`);
    assert.equal(result.appTerminated, closes ? 1 : 0, `exit ${status}`);
    result.methods['checkServer:'].implementation();
    assert.equal(result.alerts.length, message ? 1 : 0, 'an exit is reported once');
  }
});
