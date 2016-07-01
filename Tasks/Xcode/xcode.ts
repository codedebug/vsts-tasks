/// <reference path="../../definitions/node.d.ts" />
/// <reference path="../../definitions/Q.d.ts" />
/// <reference path="../../definitions/vsts-task-lib.d.ts" />

import path = require('path');
import tl = require('vsts-task-lib/task');
import fs = require('fs');
import sign = require('ios-signing-common/ios-signing-common');

import {ToolRunner} from 'vsts-task-lib/toolrunner';

async function run() {
    try {
        tl.setResourcePath(path.join( __dirname, 'task.json'));

        //--------------------------------------------------------
        // Tooling
        //--------------------------------------------------------
        tl.setEnvVar('DEVELOPER_DIR',tl.getInput('xcodeDeveloperDir', false));

        var useXctool = (tl.getInput('useXctool', false) == "true");
        var tool = useXctool ? tl.which('xctool', true) : tl.which('xcodebuild', true);
        tl.debug('Tool selected: '+ tool);

        //--------------------------------------------------------
        // Paths
        //--------------------------------------------------------
        tl.cd(tl.getInput('cwd'));

        var outPath = path.resolve(process.cwd(), tl.getInput('outputPattern', true));
        tl.mkdirP(outPath);


        //--------------------------------------------------------
        // Xcode args
        //--------------------------------------------------------
        var ws = tl.getPathInput('xcWorkspacePath', false, false);
        if(tl.filePathSupplied('xcWorkspacePath')) {

            var workspaceMatches = tl.glob(ws);
            tl.debug("Found " + workspaceMatches.length + ' workspaces matching.');

            if (workspaceMatches.length > 0) {
                ws = workspaceMatches[0];
                if (workspaceMatches.length > 1) {
                    tl.warning('Multiple xcode workspace matches were found. Using the first match: ' + ws);
                }
            }
            else {
                throw 'Xcode workspace was specified but it does not exist or is not a directory';
            }
        }

        var sdk = tl.getInput('sdk', false);
        var configuration = tl.getInput('configuration', false);
        var scheme = tl.getInput('scheme', false);
        var xctoolReporter = tl.getInput('xctoolReporter', false);
        var actions = tl.getDelimitedInput('actions', ' ', true);
        var out = path.resolve(process.cwd(), tl.getInput('outputPattern', true));
        var packageApp = tl.getBoolInput('packageApp', true);
        var args = tl.getInput('args', false);

        //--------------------------------------------------------
        // Exec Tools
        //--------------------------------------------------------

        // --- Xcode Version ---

        var xcv = tl.createToolRunner(tool);
        xcv.arg('-version');
        await xcv.exec(null)

        //setup build
        var xcb: ToolRunner = tl.createToolRunner(tool);
        xcb.argIf(sdk, ['-sdk', sdk]);
        xcb.argIf(configuration, ['-configuration', configuration]);
        if(ws) {
            xcb.arg('-workspace');
            xcb.pathArg(ws);
        }
        xcb.argIf(scheme, ['-scheme', scheme]);
        xcb.argIf(useXctool && xctoolReporter, ['-reporter', 'plain', '-reporter', xctoolReporter]);
        xcb.arg(actions);
        xcb.arg('DSTROOT=' + path.join(out, 'build.dst'));
        xcb.arg('OBJROOT=' + path.join(out, 'build.obj'));
        xcb.arg('SYMROOT=' + path.join(out, 'build.sym'));
        xcb.arg('SHARED_PRECOMPS_DIR=' + path.join(out, 'build.pch'));
        if (args) {
            xcb.argString(args);
        }

        //--------------------------------------------------------
        // iOS signing and provisioning
        //--------------------------------------------------------
        var signMethod = tl.getInput('signMethod', false);
        var keychainToDelete : string;
        var profileToDelete : string;

        if(signMethod === 'file') {
            var p12 = tl.getPathInput('p12', false, false);
            var p12pwd = tl.getInput('p12pwd', false);
            var provProfilePath = tl.getPathInput('provProfile', false);
            var removeProfile = tl.getBoolInput('removeProfile', false);

            //create a temporary keychain and install the p12 into that keychain
            if(p12 && fs.lstatSync(p12).isFile()) {
                p12 = path.resolve(process.cwd(), p12);
                var keychain = path.join(process.cwd(), '_xcodetasktmp.keychain');
                var keychainPwd = Math.random();

                await sign.installCertInTemporaryKeyChain(keychain, keychainPwd.toString(), p12, p12pwd);
                xcb.arg('OTHER_CODE_SIGN_FLAGS=--keychain=' + keychain);
                keychainToDelete = keychain;

                //find signing identity
                var signIdentity = await sign.findSigningIdentity(keychain);
                xcb.arg('CODE_SIGN_IDENTITY=' + signIdentity);

                var provProfileUUID = await sign.getProvisioningProfileUUID(provProfilePath);
                xcb.arg('PROVISIONING_PROFILE=' + provProfileUUID);

                if(removeProfile) {
                    profileToDelete = provProfileUUID;
                }
            }

        } else if (signMethod === 'id') {
            //TODO
        }

        //run the Xcode build
        await xcb.exec();

        //--------------------------------------------------------
        // Test publishing
        //--------------------------------------------------------

        var testResultsFiles;
        var publishResults = tl.getBoolInput('publishJUnitResults', false);
        if (publishResults && !useXctool) {
            tl.warning("Check the 'Use xctool' checkbox and specify the xctool reporter format to publish test results. No results published.");
        }

        if (publishResults && useXctool && xctoolReporter && 0 !== xctoolReporter.length)
        {
            var xctoolReporterString = xctoolReporter.split(":");
            if (xctoolReporterString && xctoolReporterString.length === 2)
            {
                testResultsFiles = path.resolve(process.cwd(), xctoolReporterString[1].trim());
            }

            if(testResultsFiles && 0 !== testResultsFiles.length) {
                //check for pattern in testResultsFiles
                if(testResultsFiles.indexOf('*') >= 0 || testResultsFiles.indexOf('?') >= 0) {
                    tl.debug('Pattern found in testResultsFiles parameter');
                    var allFiles = tl.find(process.cwd());
                    var matchingTestResultsFiles = tl.match(allFiles, testResultsFiles, { matchBase: true });
                }
                else {
                    tl.debug('No pattern found in testResultsFiles parameter');
                    var matchingTestResultsFiles : string [] = [testResultsFiles];
                }

                if(!matchingTestResultsFiles) {
                    tl.warning('No test result files matching ' + testResultsFiles + ' were found, so publishing JUnit test results is being skipped.');
                }

                var tp = new tl.TestPublisher("JUnit");
                tp.publish(matchingTestResultsFiles, false, "", "", "", true);
            }
        }

        //--------------------------------------------------------
        // Package app to generate .ipa
        //--------------------------------------------------------

        if(tl.getBoolInput('packageApp', true) && sdk !== 'iphonesimulator') {
            tl.debug('Packaging apps.');
            var outPath = path.join(out, 'build.sym');
            tl.debug('outPath: ' + outPath);
            var appFolders = tl.glob(outPath + '/**/*.app')
            if (appFolders) {
                tl.debug(appFolders.length + ' apps found for packaging.');
                var xcrunPath = tl.which('xcrun', true);
                for(var i = 0; i < appFolders.length; i++) {
                    var app = appFolders.pop();
                    tl.debug('Packaging ' + app);
                    var ipa = app.substring(0, app.length-3) + 'ipa';
                    var xcr = tl.createToolRunner(xcrunPath);
                    xcr.arg(['-sdk', sdk, 'PackageApplication', '-v', app, '-o', ipa]);
                    await xcr.exec();
                }
            }
        }
        tl.setResult(tl.TaskResult.Succeeded, 'Xcode task execution completed with no errors.');
    }
    catch(err) {
        tl.setResult(tl.TaskResult.Failed, err);
    } finally {
        //delete provisioning profile if specified
        if(profileToDelete) {
            await sign.deleteProvisioningProfile(profileToDelete);
        }

        //clean up the temporary keychain, so it is not used in future builds
        if(keychainToDelete) {
            await sign.deleteKeychain(keychainToDelete);
        }
    }
}

run();
