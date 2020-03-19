/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import * as SfdmModels from "./models/index";
import { List } from 'linq.ts';
import * as path from 'path';
import * as fs from 'fs';
import "reflect-metadata";
import "es6-shim";
import { plainToClass } from "class-transformer";
import {
    parseQuery,
    composeQuery,
    FieldType,
    Field as SOQLField,
    getComposedField
} from 'soql-parser-js';
import { SfdxUtils } from "./sfdx";
import { CommonUtils } from "./common";
import SimpleCrypto from "simple-crypto-js";
import { ScriptField } from "./models/index";



export class Application {

    private startTime: Date;
    private endTime: Date;

    basePath: string;
    dataPath: string;
    filePath: string;
    password: string;

    script: SfdmModels.Script;
    orgs: Map<string, SfdmModels.SOrg> = new Map<string, SfdmModels.SOrg>();
    job: SfdmModels.Job = new SfdmModels.Job();

    constructor(ux: any) {
        this.ux = ux;
    }

    get sourceOrg(): SfdmModels.SOrg {
        return this.orgs.get(this.script.sourceKey);
    }

    get targetOrg(): SfdmModels.SOrg {
        return this.orgs.get(this.script.targetKey);
    }

    ux: any;

    getLogFilePath() {
        if (!this.filePath) {
            let p = path.join(this.basePath, '/logs/');
            if (!fs.existsSync(p)) {
                fs.mkdirSync(p);
            }
            this.filePath = path.join(p, `log_${CommonUtils.formatFileDate(new Date())}.txt`);
        }
        return this.filePath;
    }

    uxLogStart() {
        this.startTime = new Date();
        this.uxLog("Process started.");
    }

    uxLog(message: string, br: boolean = false, error: boolean = false) {
        let msg = "";
        if (message) {
            if (!error) {
                msg = `[ ${CommonUtils.formatDateTime(new Date())}] ${message}`;
                this.ux.log(msg);
            }
            else {
                msg = `[ ${CommonUtils.formatDateTime(new Date())}] [ERROR] ${message}`;
                this.ux.error(msg);
            }
            if (br) {
                this.ux.log("\n");
            }
        }
        else {
            msg = "";
            this.ux.log("\n");
        }
        if (this.basePath) {
            let isStarting = !this.filePath;
            let filePath = this.getLogFilePath();
            if (isStarting) {
                let msgStart = `[ ${CommonUtils.formatDateTime(new Date())}] Process started`;
                fs.appendFileSync(filePath, msgStart);
            }
            fs.appendFileSync(filePath, "\n" + msg);
        }
    }

    uxLogEnd() {
        this.endTime = new Date();
        this.uxLog("Process finished.");
        this.uxLog(`total time elapsed: ${CommonUtils.timeDiffString(this.startTime, this.endTime)}.`);
    }

    /**
     * Function to initialize the Application object, setup scripts, validate metadata, etc
     */
    async initApplication(baseDir: string, targetUsername: string, sourceUsername: string, password: string) {

        this.uxLog("sfdmu:move command has started.");

        // Validate usernames
        if (!sourceUsername) {
            throw new SfdmModels.PluginInitError("Missing source user name.");
        }

        if (!targetUsername) {
            throw new SfdmModels.PluginInitError("Missing target user name.");
        }

        this.password = password;

        // Setup
        this.basePath = path.isAbsolute(baseDir) ? baseDir : path.join(process.cwd(), baseDir.toString());
        this.basePath = this.basePath.replace(/([^"]+)(.*)/, "$1");

        if (!fs.existsSync(this.basePath)) {
            throw new SfdmModels.FileSystemError("The working directory does not exist");
        }

        // Read export.json script        
        let filePath = path.join(this.basePath, 'export.json');

        if (!fs.existsSync(filePath)) {
            throw new SfdmModels.FileSystemError("The export.json file does not exist in the working directory");
        }

        this.uxLog("");
        this.uxLog("Loading and validating the package script...");

        let json = fs.readFileSync(filePath, 'utf8');
        let jsonObject = JSON.parse(json);
        this.script = plainToClass(SfdmModels.Script, jsonObject);

        // Filter out disabled objects
        this.script.objects = this.script.objects.filter(object => {
            let ret = !object.excluded || object.operation == SfdmModels.Enums.OPERATION.Readonly;
            if (!ret) {
                this.uxLog(`[NOTE] sObject ${object.name} will be excluded from the process.`);
            }
            return ret;
        });

        if (this.script.objects.length == 0) {
            throw new SfdmModels.PluginInitError("There are no objects defined to process.");
        }

        this.script.targetOrg = targetUsername;
        this.script.sourceOrg = sourceUsername;

        this.uxLog(`Source Org: ${this.script.sourceOrg}.`);
        this.uxLog(`Target Org: ${this.script.targetOrg}.`);
        this.uxLog(`Script file: ${filePath}.`);
        if (password) {
            this.uxLog(`Password: ${password}.`);
        }

        // Encryption
        let invalidPassword = false;
        if (password) {
            var simpleCrypto = new SimpleCrypto(password);
            this.script.orgs.forEach(org => {
                let name = simpleCrypto.decrypt(org.name).toString();
                if (name) {
                    org.name = name;
                    org.instanceUrl = simpleCrypto.decrypt(org.instanceUrl).toString();
                    org.accessToken = simpleCrypto.decrypt(org.accessToken).toString();
                } else {
                    invalidPassword = true;
                }
            });
        }
        if (invalidPassword) {
            this.uxLog(`[WARNING] Invalid password. Original unencrypted credentials will be used.`);
        }

        if (sourceUsername.toLowerCase() == "file") {
            this.script.sourceOrg = this.script.targetOrg;
            this.script.sourceMedia = SfdmModels.Enums.DATA_MEDIA_TYPE.File;
        }

        // Detect media types
        if (targetUsername.toLowerCase() == "file") {
            this.script.targetOrg = this.script.sourceOrg;
            this.script.targetMedia = SfdmModels.Enums.DATA_MEDIA_TYPE.File;
        }

        // Create connections to the orgs
        let sourceScriptOrg = new List<SfdmModels.ScriptOrg>(this.script.orgs).FirstOrDefault(x => x.name == this.script.sourceOrg);
        if (!sourceScriptOrg || !sourceScriptOrg.accessToken) {
            try {
                // Connection is not found int the package. Try to retrieve credentials from the SFDX.
                this.uxLog(`Trying to connect to ${sourceUsername} using SFDX CLI...`);
                let s = SfdxUtils.execSfdx("force:org:display", sourceUsername);
                let p = SfdxUtils.parseForceOrgDisplayResult(s);
                if (!p.isConnected){
                    throw new Error();
                }
                this.uxLog(`Successfully connected to ${p.Username}`);
                this.uxLog(`Access token: ${p.AccessToken}`);
                this.orgs.set(this.script.sourceKey, new SfdmModels.SOrg(p.Username, p.AccessToken, p.InstanceUrl, this.basePath, this.script.sourceMedia, true));
            } catch (e) {
                throw new SfdmModels.PluginInitError(`Attempt to connect to ${sourceUsername} using SFDX CLI failed. Please, refresh your local connection details.`);
            }
        } else {
            this.orgs.set(this.script.sourceKey, new SfdmModels.SOrg(sourceScriptOrg.name, sourceScriptOrg.accessToken, sourceScriptOrg.instanceUrl, this.basePath, this.script.sourceMedia, true));
        }


        let targetScriptOrg = new List<SfdmModels.ScriptOrg>(this.script.orgs).FirstOrDefault(x => x.name == this.script.targetOrg);
        if (!targetScriptOrg || !targetScriptOrg.accessToken) {
            try {
                // Connection is not found int the package. Try to retrieve credentials from the SFDX.
                this.uxLog(`Trying to connect to ${targetUsername} using SFDX CLI...`);
                let s = SfdxUtils.execSfdx("force:org:display", targetUsername);
                let p = SfdxUtils.parseForceOrgDisplayResult(s);
                if (!p.isConnected){
                    throw new Error();
                }
                this.uxLog(`Successfully connected to ${p.Username}`);
                this.uxLog(`Access token: ${p.AccessToken}`);
                this.orgs.set(this.script.targetKey, new SfdmModels.SOrg(p.Username, p.AccessToken, p.InstanceUrl, this.basePath, this.script.targetMedia, false));
            } catch (e) {
                throw new SfdmModels.PluginInitError(`Attempt to connect to ${targetUsername} using SFDX CLI failed. Please, refresh your local connection details.`);
            }
        } else {
            this.orgs.set(this.script.targetKey, new SfdmModels.SOrg(targetScriptOrg.name, targetScriptOrg.accessToken, targetScriptOrg.instanceUrl, this.basePath, this.script.targetMedia, false));
        }

        this.orgs.forEach(org => {
            org.pollingIntervalMs = this.script.pollingIntervalMs;
            org.bulkThreshold = this.script.bulkThreshold;
            org.version = this.script.apiVersion;
            org.allOrNone = this.script.allOrNone;
            org.createTargetCSVFiles = this.script.createTargetCSVFiles;
        });

        if (this.sourceOrg.isEquals(this.targetOrg)) {
            throw new SfdmModels.PluginInitError("The source and the target could not be the same");
        }

        // Validate access token
        try {
            await SfdxUtils.validateAccessToken(this.sourceOrg);
        } catch (e) {
            throw new SfdmModels.PluginInitError("Access token to the Source Org has expired or the user has no access to it. Please reconnect.");
        }

        try {
            await SfdxUtils.validateAccessToken(this.targetOrg);
        } catch (e) {
            throw new SfdmModels.PluginInitError("Access token to the Target Org has expired or the user has no access to it. Please reconnect.");
        }

        // Parse queries
        this.script.objects.forEach(object => {

            if (CommonUtils.isString(object.operation))
                object.operation = <SfdmModels.Enums.OPERATION>SfdmModels.Enums.OPERATION[object.operation.toString()];

            try {
                object.parsedQuery = parseQuery(object.query);
                if (object.operation == SfdmModels.Enums.OPERATION.Delete) {
                    object.deleteOldData = true;
                    object.parsedQuery.fields = [getComposedField("Id")];
                }
            } catch (e) {
                throw new SfdmModels.PluginInitError(`Malformed query for the sObject ${object.name}: ${object.query}, error: ${e}.`);
            }

            if (object.deleteOldData && object.operation == SfdmModels.Enums.OPERATION.Upsert) {
                object.operation = SfdmModels.Enums.OPERATION.Insert;
            }

            object.name = object.parsedQuery.sObject;
            this.script.objectsMap.set(object.name, object);

            if (object.deleteOldData) {
                try {
                    if (object.deleteQuery) {
                        object.parsedDeleteQuery = parseQuery(object.deleteQuery);
                    } else {
                        object.parsedDeleteQuery = parseQuery(object.query);
                    }
                    object.parsedDeleteQuery.fields = [getComposedField("Id")];
                } catch (e) {
                    throw new SfdmModels.PluginInitError(`Malformed delete query for the sObject ${object.name}: ${object.deleteQuery}, error: ${e}.`);
                }
            }

        });



        // Add RecordType object if mssing & needed
        if (this.script.objects.filter(x => x.parsedQuery.fields.filter(x1 => (<SOQLField>x1).field == "RecordTypeId").length > 0).length > 0
            && this.script.objects.filter(x => x.name == "RecordType").length == 0) {
            let rtObject: SfdmModels.ScriptObject = new SfdmModels.ScriptObject({
                name: "RecordType",
                externalId: "DeveloperName",
                isExtraObject: true,
                allRecords: true,
                fieldsMap: new Map<string, ScriptField>(),
                query: "SELECT Id FROM RecordType",
                operation: SfdmModels.Enums.OPERATION.Readonly
            });
            this.script.objects.push(rtObject);
            rtObject.parsedQuery = parseQuery(rtObject.query);
            this.script.objectsMap.set(rtObject.name, rtObject);
        }


        var recordTypeSObjectTypes: List<string> = new List<string>();
        var recordTypeScriptObject: SfdmModels.ScriptObject;
        let scriptObjectsList = new List<SfdmModels.ScriptObject>(this.script.objects);


        // Describe sObjects
        this.uxLog("");
        this.uxLog("Executing the package script...");
        this.uxLog("Preparing...");
        this.uxLog("Getting org metadata...");

        for (let i = 0; i < this.script.objects.length; i++) {

            let object: SfdmModels.ScriptObject = this.script.objects[i];

            // Validaiton external id
            if (object.operation != SfdmModels.Enums.OPERATION.Insert
                && object.operation != SfdmModels.Enums.OPERATION.Readonly
                && !object.isComplexExternalId
                && !object.externalId) {
                throw new SfdmModels.MetadataError(`Object ${object.name} has no ExternalId key defined. ${object.strOperation} operation required explicit ExternalId definition.`);
            }

            // Describe source sObject
            try {
                object.sObjectDescribe = await SfdxUtils.describeSObjectAsync(object.name, this.sourceOrg, this.targetOrg.sObjectsMap);
            } catch (e) {
                throw new SfdmModels.MetadataError(`Object ${object.name} defined in the Script does not exist in the Source`);
            }

            // Describe target sObject
            try {
                object.sObjectDescribeTarget = await SfdxUtils.describeSObjectAsync(object.name, this.targetOrg, this.sourceOrg.sObjectsMap);
            } catch (e) {
                throw new SfdmModels.MetadataError(`Object ${object.name} defined in the Script does not exist in the Target`);
            }
        }


        // Compose query fields for the "Delete" objects
        // (Needed to build proper task order depend on the relationships between objects)
        this.script.objects.forEach(object => {
            if (object.operation == SfdmModels.Enums.OPERATION.Delete) {
                this.script.objects.forEach(obj => {
                    if (obj != object) {
                        let f = [...object.sObjectDescribe.fieldsMap.values()].filter(field => field.referencedObjectType == obj.name);
                        if (f.length > 0) {
                            object.parsedQuery.fields.push(getComposedField(f[0].name));
                        }
                    }
                });
            }
        });


        // Analysing relationships and building script data
        this.uxLog("Analysing object metadata...");

        for (let i = 0; i < this.script.objects.length; i++) {

            let object: SfdmModels.ScriptObject = this.script.objects[i];

            // Describe sObject where there this no describtion
            if (!object.sObjectDescribe) {

                // Describe target sObject
                try {
                    object.sObjectDescribe = await SfdxUtils.describeSObjectAsync(object.name, this.sourceOrg, this.targetOrg.sObjectsMap);
                } catch (e) {
                    throw new SfdmModels.MetadataError(`Object ${object.name} defined in the Script does not exist in the Source`);
                }

                // Describe target sObject
                try {
                    object.sObjectDescribeTarget = await SfdxUtils.describeSObjectAsync(object.name, this.targetOrg, this.sourceOrg.sObjectsMap);
                } catch (e) {
                    throw new SfdmModels.MetadataError(`Object ${object.name} defined in the Script does not exist in the Target`);
                }
            }

            var scriptFieldsList = new List<FieldType>(object.parsedQuery.fields).Cast<SOQLField>();

            // Add Id field to the SOQL if missing
            if (!scriptFieldsList.Any(x => (<SOQLField>x).field == "Id")) {
                var f = getComposedField("Id");
                object.parsedQuery.fields.push(f);
                scriptFieldsList.Add(<SOQLField>f);
            }

            // Add ExternalId field to the SOQL if missing
            if (!scriptFieldsList.Any(x => (<SOQLField>x).field == object.externalId)) {

                if (object.isComplexExternalId) {
                    object.externalId = object.complexExternalIdKey;
                    let fdescribe = new SfdmModels.SFieldDescribe({
                        label: object.externalId,
                        name: object.externalId,
                        updateable: false,
                        creatable: false,
                        cascadeDelete: false,
                        autoNumber: false,
                        custom: true,
                        calculated: true,
                        isReference: false,
                        referencedObjectType: undefined
                    });
                    object.sObjectDescribe.fieldsMap.set(object.externalId, fdescribe);
                    object.sObjectDescribeTarget.fieldsMap.set(object.externalId, fdescribe);
                }

                var f = getComposedField(object.externalId);
                object.parsedQuery.fields.push(f);

                // Supress exporting external id field values
                // if originally this field was not in the query.
                object.readonlyExternalIdFields.push(object.externalId);

            } else if (object.sObjectDescribe.fieldsMap.has(object.externalId) && object.sObjectDescribe.fieldsMap.get(object.externalId).isReadonly
                || !object.sObjectDescribe.fieldsMap.has(object.externalId)) {
                // Supress exporting external id fields of non-updatable types (formula, autonumber, etc)
                object.readonlyExternalIdFields.push(object.externalId);
            }

            // Add filter by record type
            if (scriptFieldsList.Any(x => (<SOQLField>x).field == "RecordTypeId")
                || scriptFieldsList.Any(x => (<SOQLField>x).field == "RecordType.Id")) {
                recordTypeSObjectTypes.Add(object.name);
            }

            // Construct RecordType object
            if (object.name == "RecordType") {
                recordTypeScriptObject = object;
                object.isExtraObject = true;
                object.allRecords = true;
                object.operation = SfdmModels.Enums.OPERATION.Readonly;
                if (!scriptFieldsList.Any(x => (<SOQLField>x).field == "SobjectType")) {
                    var f = getComposedField("SobjectType");
                    object.parsedQuery.fields.push(f);
                    scriptFieldsList.Add(<SOQLField>f);
                }
            }
        }

        for (let i = 0; i < this.script.objects.length; i++) {

            let object: SfdmModels.ScriptObject = this.script.objects[i];

            var scriptFieldsList = new List<FieldType>(object.parsedQuery.fields).Cast<SOQLField>();

            // Generate Script Fields & build fields map 
            for (let j = 0; j < scriptFieldsList.Count(); j++) {

                const fld = scriptFieldsList.ElementAt(j);

                let field = new SfdmModels.ScriptField({
                    name: fld.field,
                    sObject: object
                });

                object.fields.push(field);

                // Validate object metadata
                field.sFieldDescribe = object.sObjectDescribe.fieldsMap.get(field.name);
                if (field.sFieldDescribe == null /*&& !field.isComplexField*/) {
                    throw new SfdmModels.MetadataError(`Missing field ${object.name + '.' + field.name} the Source`);
                }

                // Validate target object metadata
                field.sFieldDescribeTarget = object.sObjectDescribeTarget.fieldsMap.get(field.name);

                if (field.sFieldDescribeTarget == null /* && !field.isComplexField*/) {
                    throw new SfdmModels.MetadataError(`Missing field ${object.name + '.' + field.name} in the Target`);
                }

                // Build references
                if (field.sFieldDescribe.isReference) {

                    let refObj: SfdmModels.ScriptObject = scriptObjectsList.FirstOrDefault(x => x.name == field.referencedSObjectType);

                    if (!refObj) {
                        // Add readonly reference object if missing
                        refObj = new SfdmModels.ScriptObject({
                            name: field.referencedSObjectType,
                            externalId: "Name",
                            isExtraObject: true,
                            allRecords: true,
                            fieldsMap: new Map<string, ScriptField>(),
                            query: `SELECT Id, Name FROM ${field.referencedSObjectType}`,
                            operation: SfdmModels.Enums.OPERATION.Readonly
                        });
                        refObj.parsedQuery = parseQuery(refObj.query);
                        this.script.objectsMap.set(refObj.name, refObj);
                        this.script.objects.push(refObj);

                        if (!refObj.sObjectDescribe) {

                            // Describe target sObject
                            try {
                                refObj.sObjectDescribe = await SfdxUtils.describeSObjectAsync(refObj.name, this.sourceOrg, this.targetOrg.sObjectsMap);
                            } catch (e) {
                                throw new SfdmModels.MetadataError(`Object ${refObj.name} defined in the Script does not exist in the Source`);
                            }

                            // Describe target sObject
                            try {
                                refObj.sObjectDescribeTarget = await SfdxUtils.describeSObjectAsync(refObj.name, this.targetOrg, this.sourceOrg.sObjectsMap);
                            } catch (e) {
                                throw new SfdmModels.MetadataError(`Object ${refObj.name} defined in the Script does not exist in the Target`);
                            }
                        }
                    }

                    if (!refObj.externalId) {
                        throw new SfdmModels.ScriptError(`Field ${object.name + '.' + field.name} references to the SObject of type ${field.sFieldDescribe.name} that is missing ExternalId definition in the Script`);
                    }

                    object.fieldsMap.set(field.name, field);


                    // Important! For reference fields => replace original external id key 
                    // with the external id key of the referenced script object
                    field.externalId = refObj.externalId;


                } else {
                    object.fieldsMap.set(field.name, field);
                }

            }

            object.fields = [...object.fieldsMap.values()];

        }

        // Referenced fields for all objects
        this.script.objects.forEach(object => {

            object.fields.forEach(field => {
                // Referenced field
                if (field.sFieldDescribe.isReference) {
                    // Add referenced field to the object 
                    let o = this.script.objectsMap.get(field.referencedSObjectType);
                    if (o) {
                        let ff = o.fieldsMap.get(field.externalId);
                        if (ff) {
                            object.referencedFieldMap.set(field.referencedFullFieldName, [field, ff]);
                        }
                    }

                }
            });
        });

        // Construct query for the RecordType object
        if (recordTypeScriptObject != null) {
            let pq = recordTypeScriptObject.parsedQuery;
            pq.where = SfdxUtils.composeWhereInClause(pq.where, "SobjectType", recordTypeSObjectTypes.ToArray());
            recordTypeScriptObject.query = composeQuery(pq);
        }

        // Build map to the parent references
        this.script.objects.forEach(object => {
            let references = object.getReferencedSObjectTypes();
            references.ForEach(reference => {
                object.referencedScriptObjectsMap.set(reference, this.script.objectsMap.get(reference));
            });
        });

    }



    /**
     * Function to create job object with properly ordered task objects
     */
    async initJob() {

        this.uxLog("Data migration process is starting...");
        this.uxLog("Building migration strategy...");

        // Create Tasks and put them i nright order
        this.script.objects.forEach(object => {

            // Create new Task
            let task: SfdmModels.Task = new SfdmModels.Task({
                scriptObject: object,
                job: this.job
            });

            // Add task fields for the original query
            // (without referenced fields)
            task.createOriginalTaskFields();

            if (object.name == "RecordType") {
                // Record type task must be always in the top
                this.job.tasks.Insert(0, task);
            } else if (this.job.tasks.Count() == 0) {
                this.job.tasks.Add(task);
            } else {
                let index: number = this.job.tasks.Count();
                for (var i = this.job.tasks.Count() - 1; i >= 0; i--) {
                    var theTask = this.job.tasks.ElementAt(i);
                    if (theTask.scriptObject.referencedScriptObjectsMap.has(object.name)
                        // ... and check if the parent task has no limits
                        //&& !object.parsedQuery.limit
                    ) {
                        // This task is the parent => push this task before
                        index = i;
                    }
                    // ... or leave it at the current place in the chain
                }
                // Insert the task in the desired
                this.job.tasks.Insert(index, task);
            }

        });

        // Correct master-details => put master-detail parents before
        let updatedTasks: List<SfdmModels.Task> = new List<SfdmModels.Task>();

        updatedTasks.Add(this.job.tasks.Last());

        for (var i = this.job.tasks.Count() - 2; i >= 0; i--) {
            var theTaskPrev = this.job.tasks.ElementAt(i);
            updatedTasks.Add(theTaskPrev);
            for (var j = i + 1; j < this.job.tasks.Count(); j++) {
                var theTaskNext = this.job.tasks.ElementAt(j);
                let masterDetailReferencedScriptObjects = new List<SfdmModels.ScriptObject>([...theTaskPrev.scriptObject.referencedScriptObjectsMap.values()])
                    .Where(preRefObj => {
                        // Detect master-detail parent in theTaskNext
                        let ret = preRefObj.name == theTaskNext.sObjectName &&
                            theTaskPrev.scriptObject.fields.filter(f => {
                                let ret = f.sFieldDescribe.referencedObjectType == preRefObj.name && f.sFieldDescribe.isMasterDetail;
                                return ret;
                            }).length > 0;

                        return ret;
                    });


                if (masterDetailReferencedScriptObjects.Count() > 0) {
                    masterDetailReferencedScriptObjects.ForEach(object => {
                        let refTask = this.job.tasks.FirstOrDefault(x => x.sObjectName == object.name);
                        this.job.tasks.Remove(refTask);
                        updatedTasks.Remove(refTask);
                        updatedTasks.Add(refTask);
                    });
                }
            }
        }

        this.job.tasks = updatedTasks.Reverse();

        this.job.tasks.ForEach(task => {
            task.createReferencedTaskFields();
        });

        this.uxLog(`Execution order:\n${this.job.tasks.Select(x => x.sObjectName).ToArray().join(", ")}\n`, true);
    }


    /**
     * Executes the Job.
     */
    async executeJob() {



        let _app: Application = this;

        // Content of all csv files
        let csvDataCacheMap: Map<string, Map<string, any>> = new Map<string, Map<string, any>>();

        // ---------------------------------
        // ---------------------------------
        // ---------------------------------
        // ---------------------------------
        // 0 step. Prerequisites
        // Validate and prepare raw CSV source files ********************************

        if (this.sourceOrg.mediaType == SfdmModels.Enums.DATA_MEDIA_TYPE.File && !(this.script.encryptDataFiles && this.password)) {

            this.uxLog("Validating and fixing source CSV files...");


            // A. Merge User / Group into UserAndGroup ----------------------//

            let filepath1 = path.join(this.sourceOrg.basePath, "User.csv");
            let filepath2 = path.join(this.sourceOrg.basePath, "Group.csv");
            let filepath3 = path.join(this.sourceOrg.basePath, SfdmModels.CONSTANTS.USER_AND_GROUP_FILE_NAME + ".csv");

            await CommonUtils.mergeCsvFiles(filepath1, filepath2, filepath3, true, "Id", "Name");




            // B. Add missing referenced lookup fields and process external id columns ----------------------//

            let csvIssues: Array<{
                "Date": string,
                "Severity level": string,
                "Child sObject name": string,
                "Child field name": string,
                "Parent record Id": string,
                "Parent sObject name": string,
                "Parent sObject external Id field name": string,
                "Error description": string
            }> = new Array<any>();

            let csvFilePathsToUpdate: Set<string> = new Set<string>();

            for (let i = 0; i < this.job.tasks.Count(); i++) {

                let task = this.job.tasks.ElementAt(i);

                if (task.scriptObject.operation == SfdmModels.Enums.OPERATION.Delete)
                    continue;

                let filepath = path.join(this.sourceOrg.basePath, task.sObjectName);
                if (task.sObjectName == "User" || task.sObjectName == "Group") {
                    filepath = path.join(this.sourceOrg.basePath, SfdmModels.CONSTANTS.USER_AND_GROUP_FILE_NAME);
                }
                filepath += ".csv";

                // Check the source CSV file for this task
                let csvColumnsRow = await CommonUtils.readCsvFile(filepath, 1);
                if (csvColumnsRow.length == 0) {
                    csvIssues.push({
                        Date: CommonUtils.formatDateTime(new Date()),
                        "Severity level": "HIGHEST",
                        "Child sObject name": task.sObjectName,
                        "Child field name": null,
                        "Parent sObject name": null,
                        "Parent sObject external Id field name": null,
                        "Parent record Id": null,
                        "Error description": "CSV FILE IS EMPTY OR DOES NOT EXIST"
                    });
                    continue;
                }

                for (let j = 0; j < task.taskFields.Count(); j++) {

                    const taskField = task.taskFields.ElementAt(j);

                    if (taskField.isOriginalField && !csvColumnsRow[0].hasOwnProperty(taskField.name)) {
                        csvIssues.push({
                            Date: CommonUtils.formatDateTime(new Date()),
                            "Severity level": "NORMAL",
                            "Child sObject name": task.sObjectName,
                            "Child field name": taskField.name,
                            "Parent sObject name": null,
                            "Parent sObject external Id field name": null,
                            "Parent record Id": null,
                            "Error description": "COLUMN DEFINED IN THE SCRIPT IS MISSING IN THE CSV FILE"
                        });
                    }

                    if (taskField.isReference && !taskField.isOriginalField) {


                        // Add missing reference lookup columns *************************

                        // Checking and filling values for the column "Account__r.AccountNumber"
                        // with external id values taken from the parent sObject csv files

                        // *****************************************************************************
                        // Account__c
                        let refSObjectName = taskField.originalScriptField.referencedSObjectType;
                        // AccountNumber
                        let refSObjectExternalIdFieldName = taskField.originalScriptField.externalId;

                        // Account__r.AccountNumber
                        let columnName = taskField.name;
                        // Account__c
                        let lookupFieldName = taskField.originalScriptField.name;

                        let parentTask = this.job.tasks.FirstOrDefault(x => x.sObjectName == refSObjectName)
                        if (!parentTask || parentTask.scriptObject.operation == SfdmModels.Enums.OPERATION.Readonly
                            || parentTask.scriptObject.operation == SfdmModels.Enums.OPERATION.Delete) {
                            continue;
                        }

                        if (!csvColumnsRow[0].hasOwnProperty(columnName)
                            // TODO: Add support for $$combined fields$$
                            && !taskField.originalScriptField.isComplexExternalId) {

                            // Read child CSV file (current)
                            let m: Map<string, any> = await CommonUtils.readCsvFileWithCache(csvDataCacheMap, filepath);

                            let refFilepath = path.join(this.sourceOrg.basePath, refSObjectName);
                            if (refSObjectName == "User" || refSObjectName == "Group") {
                                refFilepath = path.join(this.sourceOrg.basePath, SfdmModels.CONSTANTS.USER_AND_GROUP_FILE_NAME);
                            }
                            refFilepath += ".csv";

                            // Read parent CSV file
                            m = await CommonUtils.readCsvFileWithCache(csvDataCacheMap, refFilepath);
                            if (!m) {
                                csvIssues.push({
                                    Date: CommonUtils.formatDateTime(new Date()),
                                    "Severity level": "HIGH",
                                    "Child sObject name": task.sObjectName,
                                    "Child field name": lookupFieldName,
                                    "Parent sObject name": refSObjectName,
                                    "Parent sObject external Id field name": refSObjectExternalIdFieldName,
                                    "Parent record Id": null,
                                    "Error description": "CSV FILE FOR THE PARENT SOBJECT IS EMPTY OR DOES NOT EXIST"
                                });
                                continue;
                            }

                            // Mark current CSV file for further update
                            csvFilePathsToUpdate.add(filepath);

                            let rows: Map<string, any> = csvDataCacheMap.get(filepath);
                            let refRows: Map<string, any> = csvDataCacheMap.get(refFilepath);
                            let values = [...rows.values()];
                            values.forEach(value => {
                                if (typeof value[columnName] == "undefined") {
                                    // Id from Account csv
                                    let id = value[lookupFieldName];
                                    let extIdValue: any;
                                    if (id && refRows.get(id)) {
                                        // Value from Account.AccountNumber
                                        extIdValue = refRows.get(id)[refSObjectExternalIdFieldName];
                                    }
                                    if (typeof extIdValue != "undefined") {
                                        // Value of "Account.AccountNumber"  putting to  "Account__r.Customer_number__c"
                                        value[columnName] = extIdValue;
                                    } else {
                                        // If no value from parent csv and no original value => output error
                                        csvIssues.push({
                                            Date: CommonUtils.formatDateTime(new Date()),
                                            "Severity level": "NORMAL",
                                            "Child sObject name": task.sObjectName,
                                            "Child field name": lookupFieldName,
                                            "Parent sObject name": refSObjectName,
                                            "Parent sObject external Id field name": refSObjectExternalIdFieldName,
                                            "Parent record Id": id,
                                            "Error description": "MISSING PARENT RECORD FOR THE GIVEN LOOKUP VALUE"
                                        });
                                        value[columnName] = null;
                                    }
                                }
                            });

                        }

                    } else if (!taskField.isReference
                        && taskField.isOriginalField
                        && !taskField.name.startsWith(SfdmModels.CONSTANTS.COMPLEX_FIELDS_QUERY_PREFIX)) {

                        // Process external Id columns coming from the external system *************************

                        // Trasnpose column  "Account__c!Customer_number__c" to:
                        // Account__c, Account__r.AccountNumber, Customer__number__c

                        // *****************************************************************************

                        let columnName = Object.keys(csvColumnsRow[0]).filter(key => {
                            return key.toLowerCase().indexOf(`${SfdmModels.CONSTANTS.CSV_COMPLEX_FIELDS_COLUMN_SEPARATOR}${taskField.name.toLowerCase()}`) >= 0;
                        })[0];

                        if (columnName) {

                            // External id column => Add fake lookup column
                            let parts = columnName.split(SfdmModels.CONSTANTS.CSV_COMPLEX_FIELDS_COLUMN_SEPARATOR);
                            if (parts.length < 2) {
                                csvIssues.push({
                                    Date: CommonUtils.formatDateTime(new Date()),
                                    "Severity level": "HIGH",
                                    "Child sObject name": task.sObjectName,
                                    "Child field name": null,
                                    "Parent sObject name": null,
                                    "Parent sObject external Id field name": null,
                                    "Parent record Id": null,
                                    "Error description": `COLUMN ${columnName} HAS INVALID FORMAT`
                                });
                                continue;
                            }
                            // Account__c
                            let lookupField = parts[0].toLowerCase();
                            // Customer_number__c
                            let tempExtIdField = parts[1].toLowerCase();

                            let m: Map<string, any> = await CommonUtils.readCsvFileWithCache(csvDataCacheMap, filepath);

                            // Task field for Account__c
                            let lookupTaskField = task.taskFields.Where(x => x.name.toLowerCase() == lookupField);
                            // Task field for Customer_number__c
                            let tempExtIdTaskField = task.taskFields.Where(x => x.name.toLowerCase() == tempExtIdField);

                            if (lookupTaskField.Count() == 0) {
                                csvIssues.push({
                                    Date: CommonUtils.formatDateTime(new Date()),
                                    "Severity level": "HIGH",
                                    "Child sObject name": task.sObjectName,
                                    "Child field name": null,
                                    "Parent sObject name": null,
                                    "Parent sObject external Id field name": null,
                                    "Parent record Id": null,
                                    "Error description": `COLUMN "${columnName}" WILL NOT BE PROCESSED BECAUSE THE FIELD "${parts[0]}" IS MISSING IN THE SCRIPT`
                                });
                            } else {
                                lookupField = lookupTaskField.ElementAt(0).name;
                            }

                            if (tempExtIdTaskField.Count() == 0) {
                                csvIssues.push({
                                    Date: CommonUtils.formatDateTime(new Date()),
                                    "Severity level": "HIGH",
                                    "Child sObject name": task.sObjectName,
                                    "Child field name": null,
                                    "Parent sObject name": null,
                                    "Parent sObject external Id field name": null,
                                    "Parent record Id": null,
                                    "Error description": `COLUMN "${columnName}" WILL NOT BE PROCESSED BECAUSE THE FIELD "${parts[1]}" IS MISSING IN THE SCRIPT`
                                });
                            } else {
                                tempExtIdField = tempExtIdTaskField.ElementAt(0).name;
                            }

                            if (lookupTaskField.Count() == 0 || tempExtIdTaskField.Count() == 0) {
                                continue;
                            }

                            // Account__r.AccountNumber (in case that AccountNumber is external id for Account)
                            let extIdField = lookupTaskField.ElementAt(0).externalIdTaskField.name;
                            let csvRows = [...m.values()];

                            csvRows.forEach(row => {
                                row[lookupField] = row[lookupField] || '0011p00002Zh1kr'; // Fake id
                                row[extIdField] = row[columnName];
                                row[tempExtIdField] = row[columnName];
                                delete row[columnName];
                            });

                            // Mark current CSV file for further update                            
                            csvFilePathsToUpdate.add(filepath);

                        }
                    }
                }
                // ****************************************************************************************************
            }

            // Write to all changed csv files
            let csvFilePaths = [...csvDataCacheMap.keys()];
            for (let index = 0; index < csvFilePaths.length; index++) {
                let csvFilePath = csvFilePaths[index];
                if (csvFilePathsToUpdate.has(csvFilePath)) {
                    let values = [...csvDataCacheMap.get(csvFilePath).values()];
                    this.uxLog(`Updating file ${csvFilePath}...`);
                    await CommonUtils.writeCsvFile(csvFilePath, values, true);
                }
            }


            // Write to csv  format issues file
            let csvIssuesFilepath = path.join(this.sourceOrg.basePath, SfdmModels.CONSTANTS.CSV_LOOKUP_ERRORS_FILE_NAME);

            await CommonUtils.writeCsvFile(csvIssuesFilepath, csvIssues, true);            

            if (csvIssues.length == 0) {
                this.uxLog(`There are no issues found during the last validation of the source CSV files.`);
            } else {
                this.uxLog(`[WARNING] During the validation of the source CSV files ${csvIssues.length} issues were found. See ${SfdmModels.CONSTANTS.CSV_LOOKUP_ERRORS_FILE_NAME} file for the details.`);
                if (this.script.promptOnMissingParentObjects) {
                    var ans = await CommonUtils.promptUser(`Continue the job (y/n)?`);
                    if (ans != 'y' && ans != 'yes') {
                        throw new SfdmModels.JobAbortedByUser("Issues in the source CSV file(s) were found.");
                    }
                }
            }

            // Format report
            if (csvFilePathsToUpdate.size > 0) {
                this.uxLog(`${csvFilePathsToUpdate.size} CSV files were updated.`);
            }
            this.uxLog("Validating and fixing source CSV files finished.");


            // Only csv validation
            if (this.script.validateCSVFilesOnly)
                return;

        }






        // ---------------------------------
        // ---------------------------------
        // ---------------------------------
        // ---------------------------------
        // 1 step. Delete old target records  
        this.uxLog("");
        this.uxLog("STEP 1. Deleting old data.");
        if (this.targetOrg.mediaType == SfdmModels.Enums.DATA_MEDIA_TYPE.Org) {
            for (let i = this.job.tasks.Count() - 1; i >= 0; i--) {

                let task = this.job.tasks.ElementAt(i);

                if (task.scriptObject.operation == SfdmModels.Enums.OPERATION.Readonly) continue;

                // DELETE
                if (task.scriptObject.deleteOldData) {

                    task.scriptObject.deleteOldData = false;

                    this.uxLog(`Deleting records from target sObject ${task.sObjectName}...`);

                    // Query target to delete
                    let tempQuery = task.createDeleteQuery();

                    this.uxLog(`Querying target sObject: ${task.sObjectName}... Query string: ${tempQuery}.`);
                    let queriedRecords: List<object>;
                    try {
                        queriedRecords = await SfdxUtils.queryAndParseAsync(tempQuery, this.targetOrg);
                    } catch (e) {
                        throw new SfdmModels.JobError("Query error: " + e + ".");
                    }
                    this.uxLog(`Querying finished. Retrieved ${queriedRecords.Count()} records.`);

                    if (queriedRecords.Count()) {

                        // Make delete of target records
                        this.uxLog(`Deleting records from target sObject ${task.sObjectName}... ${queriedRecords.Count()} records will be deleted.`);

                        let errorMessage = "";
                        try {
                            await SfdxUtils.deleteAsync(task.sObjectName, queriedRecords, this.targetOrg, function (a, b) {
                                if (b) {
                                    if (b.message) {
                                        _app.uxLog(b.message)
                                    } else {
                                        if (b.numberRecordsFailed == 0)
                                            _app.uxLog(`Job# [${b.jobId}] (sObject ${task.sObjectName}) progress: ${b.numberRecordsProcessed} records, failed ${b.numberRecordsFailed}, error: ${b.error}.`);
                                        else {
                                            errorMessage = `Job# [${b.jobId}] (sObject ${task.sObjectName}) progress: ${b.numberRecordsProcessed} records, failed ${b.numberRecordsFailed}, error: ${b.error}.`;
                                        }
                                    }
                                }
                            })

                            if (errorMessage) {
                                throw new Error(errorMessage);
                            }

                        } catch (e) {
                            if (!this.script.promptOnUpdateError)
                                throw new SfdmModels.JobError("Data delete error: " + e);
                            else {
                                var ans = await CommonUtils.promptUser(`Data delete error. Continue the job (y/n)?`);
                                if (ans != 'y' && ans != 'yes') {
                                    throw new SfdmModels.JobAbortedByUser("Data delete error: " + e + ".");
                                }
                            }
                        }

                    } else {
                        this.uxLog(`Nothing to delete.`);
                    }

                    this.uxLog(`Deleting records from target ${task.sObjectName} finished.`);
                }

            }
            this.uxLog("STEP 1 has finished.");
        } else {
            this.uxLog("STEP 1 has skipped.");
        }






        // ---------------------------------
        // ---------------------------------
        // ---------------------------------
        // ---------------------------------
        // 2 step. Retrieve source & target records      
        // Step 2 PASS 1 **************************
        this.uxLog("");
        this.uxLog("STEP 2. Retrieving data for migration (first run).");
        for (let i = 0; i < this.job.tasks.Count(); i++) {

            let task = this.job.tasks.ElementAt(i);

            if (task.scriptObject.operation == SfdmModels.Enums.OPERATION.Delete) continue;

            // Calculate integrity : how many records need to process
            this.uxLog(`Getting records count for SObject ${task.sObjectName}...`);

            if (!task.scriptObject.isExtraObject) {

                try {
                    let tempQuery = task.createQuery(['COUNT(Id) CNT'], true);
                    if (task.sourceTotalRecorsCount < 0) {
                        if (task.scriptObject.parsedQuery.limit > 0) {
                            task.sourceTotalRecorsCount = task.scriptObject.parsedQuery.limit;
                        } else {
                            let ret = await SfdxUtils.queryAndParseAsync(tempQuery, this.sourceOrg);
                            task.sourceTotalRecorsCount = Number.parseInt(ret.ElementAt(0)["CNT"]);
                        }
                    }

                    if (task.targetTotalRecorsCount < 0) {
                        if (task.scriptObject.parsedQuery.limit > 0) {
                            task.targetTotalRecorsCount = task.scriptObject.parsedQuery.limit;
                        } else {
                            let ret = await SfdxUtils.queryAndParseAsync(tempQuery, this.targetOrg);
                            task.targetTotalRecorsCount = Number.parseInt(ret.ElementAt(0)["CNT"]);
                        }
                    }


                    // Source rules -----------------------------
                    // Record Count rule...
                    task.scriptObject.allRecords = task.sourceTotalRecorsCount > SfdmModels.CONSTANTS.ALL_RECORDS_FLAG_AMOUNT_FROM
                        || task.targetTotalRecorsCount < SfdmModels.CONSTANTS.ALL_RECORDS_FLAG_AMOUNT_TO;

                    // Reference Object rule...
                    if (task.scriptObject.allRecords) {
                        let hasRelatedObjectWithConditions = task.taskFields.Any(x => x.parentTaskField
                            && (
                                x.parentTaskField.originalScriptField.sObject.parsedQuery.limit > 0   // Any field is referenced to object with "limit"
                                || !!x.parentTaskField.originalScriptField.sObject.parsedQuery.where  // Any field is referenced to object with "where"
                                || task.scriptObject.parsedQuery.limit > 0                            // Any field is referenced to another object & this object has "limit" 
                                || !!task.scriptObject.parsedQuery.where                              // Any field is referenced to another object & this object has "where"                                 
                                //|| !x.parentTaskField.originalScriptField.sObject.allRecords        // Any field is referenced to another field that related to the task with LIMITED RECORDS  Mode
                            ));
                        if (hasRelatedObjectWithConditions) {
                            task.scriptObject.allRecords = false;
                        }
                    }

                    // Target rules -----------------------------
                    task.scriptObject.allRecordsTarget = task.scriptObject.allRecords;

                    if (!task.scriptObject.allRecordsTarget && task.scriptObject.isComplexExternalId) {
                        task.scriptObject.allRecordsTarget = true;
                    }

                } catch (e) {
                    throw new SfdmModels.JobError("Query error: " + e + ".");
                }

            } else {
                task.scriptObject.allRecordsTarget = task.scriptObject.allRecords;
            }


            // Query source records
            if (task.scriptObject.allRecords || this.sourceOrg.mediaType != SfdmModels.Enums.DATA_MEDIA_TYPE.Org) {

                // Get all records as in original query from the script including additional referenced fields
                let tempQuery = task.createQuery();

                // Get the Source records
                this.uxLog(`Querying source sObject ${task.sObjectName} (ALL_RECORDS mode)... Query string: ${tempQuery}.`);
                try {
                    task.sourceRecordSet.set(SfdmModels.Enums.RECORDS_SET.Main, await SfdxUtils.queryAndParseAsync(tempQuery,
                        this.sourceOrg,
                        true,
                        this.script.encryptDataFiles ? this.password : null));
                    this.uxLog(`Querying finished. Retrieved ${task.sourceRecordSet.get(SfdmModels.Enums.RECORDS_SET.Main).Count()} records.`);
                } catch (e) {
                    throw new SfdmModels.JobError("Query error: " + e + ".");
                }

            } else {

                this.uxLog(`Querying source sObject ${task.sObjectName} (IN_RECORDS mode).`);

                // Get records including additional referenced fields with limiting by the parent object backwards
                // Get the Source records  
                let tempQueryList = task.createListOfLimitedQueries(true);
                let rec: Map<string, Array<object>> = new Map<string, Array<object>>();

                for (let index = 0, count = tempQueryList.Count(); index < count; index++) {
                    const el = tempQueryList.ElementAt(index);
                    const query = el[0];
                    const field = el[1];
                    this.uxLog(`Executing query: ${query.substr(0, SfdmModels.CONSTANTS.IN_RECORDS_QUERY_DISPLAY_LENGTH) + "..."}`);
                    try {
                        let records = await SfdxUtils.queryAndParseAsync(query, this.sourceOrg);
                        if (!rec.has(field))
                            rec.set(field, new Array<object>());

                        rec.set(field, rec.get(field).concat(records.ToArray()));
                    } catch (e) {
                        throw new SfdmModels.JobError("Query error: " + e + ".");
                    }
                }
                let groupedRecs = SfdxUtils.groupRecords(rec, "Id", "OR");
                task.sourceRecordSet.set(SfdmModels.Enums.RECORDS_SET.Main, new List<object>(groupedRecs));
                this.uxLog(`Querying finished. Retrieved ${task.sourceRecordSet.get(SfdmModels.Enums.RECORDS_SET.Main).Count()} records.`);

            }

            // Query target records
            if (task.scriptObject.allRecordsTarget || this.sourceOrg.mediaType != SfdmModels.Enums.DATA_MEDIA_TYPE.Org) {

                // Get all records as in original query from the script including additional referenced fields
                let tempQuery = task.createQuery();

                // Get the Target records
                if (task.scriptObject.operation != SfdmModels.Enums.OPERATION.Insert && this.targetOrg.mediaType == SfdmModels.Enums.DATA_MEDIA_TYPE.Org) {
                    this.uxLog(`Querying target sObject ${task.sObjectName} (ALL_RECORDS mode)... Query string: ${tempQuery}.`);
                    try {
                        task.targetRecordSet.set(SfdmModels.Enums.RECORDS_SET.Main, await SfdxUtils.queryAndParseAsync(tempQuery, this.targetOrg));
                    } catch (e) {
                        throw new SfdmModels.JobError("Query error: " + e + ".");
                    }
                    this.uxLog(`Querying finished. Retrieved ${task.targetRecordSet.get(SfdmModels.Enums.RECORDS_SET.Main).Count()} records.`);
                } else {
                    task.targetRecordSet.set(SfdmModels.Enums.RECORDS_SET.Main, new List<object>());
                }

            } else {

                // Get the Target records
                if (task.scriptObject.operation != SfdmModels.Enums.OPERATION.Insert) {

                    this.uxLog(`Querying target sObject ${task.sObjectName} (IN_RECORDS mode)...`);

                    let tempQueryList = task.createListOfLimitedQueries(false);
                    let rec: Map<string, Array<object>> = new Map<string, Array<object>>();

                    for (let index = 0, count = tempQueryList.Count(); index < count; index++) {
                        const el = tempQueryList.ElementAt(index);
                        const query = el[0];
                        const field = el[1];
                        this.uxLog(`Executing query: ${query.substr(0, SfdmModels.CONSTANTS.IN_RECORDS_QUERY_DISPLAY_LENGTH) + "..."}`);
                        try {
                            let records = await SfdxUtils.queryAndParseAsync(query, this.targetOrg);
                            if (!rec.has(field))
                                rec.set(field, new Array<object>());

                            rec.set(field, rec.get(field).concat(records.ToArray()));
                        } catch (e) {
                            throw new SfdmModels.JobError("Query error: " + e + ".");
                        }
                    }
                    let groupedRecs = SfdxUtils.groupRecords(rec, "Id", "OR");
                    task.targetRecordSet.set(SfdmModels.Enums.RECORDS_SET.Main, new List<object>(groupedRecs));
                    this.uxLog(`Querying finished. Retrieved ${task.targetRecordSet.get(SfdmModels.Enums.RECORDS_SET.Main).Count()} records.`);
                } else {
                    task.targetRecordSet.set(SfdmModels.Enums.RECORDS_SET.Main, new List<object>());
                }


            }


        }
        this.uxLog("STEP 2 has finished.");







        // Step 2 PASS 2 **************************
        this.uxLog("");
        this.uxLog("STEP 3. Retrieving data for migration (second run).");
        for (let i = 0; i < this.job.tasks.Count(); i++) {

            let task = this.job.tasks.ElementAt(i);
            let _this = this;

            if (task.scriptObject.operation == SfdmModels.Enums.OPERATION.Delete) continue;


            // Adds source self references ****************
            async function addSelfReferencedRecordsAsync(): Promise<void> {

                let forwardsReferencedTaskFields = task.taskFields
                    .Where(x => x.externalIdTaskField && !x.externalIdTaskField.isParentTaskBefore)
                    .Select(x => x.externalIdTaskField);

                if (forwardsReferencedTaskFields.Count() > 0) {

                    let targetExtIdMap = task.targetRecordSet.get(SfdmModels.Enums.RECORDS_SET.ExtIdMap).ElementAt(0);
                    let queriedRecords = task.sourceRecordSet.get(SfdmModels.Enums.RECORDS_SET.Main);

                    for (let i = 0; i < forwardsReferencedTaskFields.Count(); i++) {
                        let field = forwardsReferencedTaskFields.ElementAt(i);
                        if (field.parentTaskField.task.sObjectName != task.sObjectName) continue;
                        let values: Array<string> = new Array<string>();
                        queriedRecords.ForEach(record => {
                            if (record[field.name])
                                values = values.concat(record[field.name]);
                        });
                        if (values.length > 0) {
                            let queries = SfdxUtils.createFieldInQueries(["Id", field.parentTaskField.name], field.parentTaskField.name, task.sObjectName, values);
                            let recordsMap = await SfdxUtils.queryMultipleAsync(queries, field.parentTaskField.name, _this.targetOrg, true);
                            [...recordsMap.keys()].forEach(key => {
                                targetExtIdMap[key] = recordsMap.get(key)["Id"];
                            });
                        }
                    }
                }
            }





            // Query records backwards
            if (!task.scriptObject.allRecords && this.sourceOrg.mediaType == SfdmModels.Enums.DATA_MEDIA_TYPE.Org) {

                // Get records including additional referenced fields with limiting by the parent object forwards
                // Get the Source records               
                let tempQueryList = task.createListOfLimitedQueries(true, false);


                if (tempQueryList.Count() > 0) {

                    this.uxLog(`Querying source sObject ${task.sObjectName} (IN_RECORDS mode)... `);

                    let rec: Map<string, Array<object>> = new Map<string, Array<object>>();
                    let totalRecords = 0;

                    rec.set('_old', task.sourceRecordSet.get(SfdmModels.Enums.RECORDS_SET.Main).ToArray());

                    for (let index = 0, count = tempQueryList.Count(); index < count; index++) {
                        const el = tempQueryList.ElementAt(index);
                        const query = el[0];
                        const field = el[1];
                        this.uxLog(`Executing query: ${query.substr(0, SfdmModels.CONSTANTS.IN_RECORDS_QUERY_DISPLAY_LENGTH) + "..."}`);
                        try {
                            let records = await SfdxUtils.queryAndParseAsync(query, this.sourceOrg);
                            if (!rec.has(field))
                                rec.set(field, new Array<object>());

                            rec.set(field, rec.get(field).concat(records.ToArray()));
                            totalRecords += records.Count();
                        } catch (e) {
                            throw new SfdmModels.JobError("Query error: " + e + ".");
                        }
                    }

                    this.uxLog(`Querying finished. Retrieved ${totalRecords} records.`);
                    if (totalRecords > 0) {
                        let groupedRecs = SfdxUtils.groupRecords(rec, "Id", "OR");
                        task.sourceRecordSet.set(SfdmModels.Enums.RECORDS_SET.Main, new List<object>(groupedRecs));
                    }
                }

                // Get the Target records
                if (task.scriptObject.operation != SfdmModels.Enums.OPERATION.Insert) {

                    tempQueryList = task.createListOfLimitedQueries(false, false);

                    if (tempQueryList.Count() > 0) {

                        this.uxLog(`Querying target sObject ${task.sObjectName} (IN_RECORDS mode)...`);

                        let rec: Map<string, Array<object>> = new Map<string, Array<object>>();
                        let totalRecords = 0;

                        rec.set('_old', task.targetRecordSet.get(SfdmModels.Enums.RECORDS_SET.Main).ToArray());

                        for (let index = 0, count = tempQueryList.Count(); index < count; index++) {
                            const el = tempQueryList.ElementAt(index);
                            const query = el[0];
                            const field = el[1];
                            this.uxLog(`Executing query: ${query.substr(0, SfdmModels.CONSTANTS.IN_RECORDS_QUERY_DISPLAY_LENGTH) + "..."}`);
                            try {
                                let records = await SfdxUtils.queryAndParseAsync(query, this.targetOrg);
                                if (!rec.has(field))
                                    rec.set(field, new Array<object>());

                                rec.set(field, rec.get(field).concat(records.ToArray()));
                                totalRecords += records.Count();
                            } catch (e) {
                                throw new SfdmModels.JobError("Query error: " + e + ".");
                            }
                        }

                        this.uxLog(`Querying finished. Retrieved ${totalRecords} records.`);
                        if (totalRecords > 0) {
                            let groupedRecs = SfdxUtils.groupRecords(rec, "Id", "OR");
                            task.targetRecordSet.set(SfdmModels.Enums.RECORDS_SET.Main, new List<object>(groupedRecs));
                        }
                    }
                }
            }

            // Build target map
            let queriedRecords = task.targetRecordSet.get(SfdmModels.Enums.RECORDS_SET.Main);
            let targetExtIdMap = task.targetRecordSet.get(SfdmModels.Enums.RECORDS_SET.ExtIdMap).ElementAt(0);

            // Add additional mapping values for self-reference field
            if (this.targetOrg.mediaType == SfdmModels.Enums.DATA_MEDIA_TYPE.Org) {
                await addSelfReferencedRecordsAsync();
            }

            queriedRecords.ForEach(record => {
                if (task.sObjectName == "RecordType")
                    targetExtIdMap[record["SobjectType"] + ";" + record[task.scriptObject.externalId]] = record["Id"];
                else
                    targetExtIdMap[record[task.scriptObject.externalId]] = record["Id"];
            });
        }
        this.uxLog("STEP 3 has finished.");






        // ---------------------------------
        // ---------------------------------
        // ---------------------------------
        // ---------------------------------
        // 4 step. Update target records - forward order
        this.uxLog("");
        this.uxLog("STEP 4. Updating target (first run).");

        // Extended csv error files
        let extendedErrorFilePaths: Array<string> = new Array<string>();

        // Init missing parent records error file **************
        let missingParentRecordsErrorsFilePath = path.join(this.sourceOrg.basePath, SfdmModels.CONSTANTS.MISSING_PARENT_RECORDS_ERRORS_FILE_NAME);
        extendedErrorFilePaths.push(missingParentRecordsErrorsFilePath);
        interface IMissingParentRecordsErrorRow {
            "Child record Id": string,
            "Child sObject": string,
            "Child external Id field": string,
            "Parent sObject": string,
            "Parent external Id field": string,
            "Missing external Id value": string
        };
        csvDataCacheMap.set(missingParentRecordsErrorsFilePath, new Map<string, IMissingParentRecordsErrorRow>());


        for (let i = 0; i < this.job.tasks.Count(); i++) {

            let task = this.job.tasks.ElementAt(i);

            if ((task.scriptObject.operation == SfdmModels.Enums.OPERATION.Readonly
                || task.scriptObject.operation == SfdmModels.Enums.OPERATION.Delete)
                && this.targetOrg.mediaType == SfdmModels.Enums.DATA_MEDIA_TYPE.Org) continue;

            let strOper = task.scriptObject.strOperation;


            let sourceRecords = task.sourceRecordSet.get(SfdmModels.Enums.RECORDS_SET.Main).DistinctBy(x => x["Id"]);
            task.sourceRecordSet.set(SfdmModels.Enums.RECORDS_SET.Main, sourceRecords);

            let targetRecords = task.targetRecordSet.get(SfdmModels.Enums.RECORDS_SET.Main).DistinctBy(x => x["Id"]);
            task.targetRecordSet.set(SfdmModels.Enums.RECORDS_SET.Main, targetRecords);

            let targetExtIdMap = task.targetRecordSet.get(SfdmModels.Enums.RECORDS_SET.ExtIdMap).ElementAt(0);

            let referencedFields = task.taskFields.Where(x => x.isReference).Select(x => x.name);

            if (this.targetOrg.mediaType == SfdmModels.Enums.DATA_MEDIA_TYPE.File) {
                // WRITE to FILE
                let objectNameToWrite = task.sObjectName;
                if (objectNameToWrite == "Group") {
                    objectNameToWrite = SfdmModels.CONSTANTS.USER_AND_GROUP_FILE_NAME;
                } else if (objectNameToWrite == "User") {
                    if (this.job.tasks.Any(x => x.sObjectName == "Group")) {
                        continue;
                    } else {
                        objectNameToWrite = SfdmModels.CONSTANTS.USER_AND_GROUP_FILE_NAME;
                    }
                }
                this.uxLog(`Writing to file ${objectNameToWrite}...`);
                await SfdxUtils.writeCsvFileAsync(objectNameToWrite,
                    sourceRecords.ToArray(),
                    this.targetOrg,
                    this.script.encryptDataFiles ? this.password : null);
                this.uxLog(`Writing to file ${objectNameToWrite} finished.`);
                continue;
            }

            this.uxLog(`${strOper}ing target sObject ${task.sObjectName}...`);

            if (referencedFields.Count() == 0) {

                // Fields without reference
                let updatedRecords: List<Object>;
                try {
                    let isChildTask = task.job.tasks.Any(x => !!x.scriptObject.referencedScriptObjectsMap.get(task.sObjectName));
                    let errorMessage = "";
                    // Update target records                    
                    updatedRecords = await SfdxUtils.processTaskDataAsync(task,
                        sourceRecords, targetRecords,
                        this.targetOrg, task.scriptObject.operation,
                        isChildTask, undefined, task.scriptObject.readonlyExternalIdFields, function (a, b) {
                            if (b) {
                                if (b.message) {
                                    _app.uxLog(b.message)
                                } else {
                                    if (b.numberRecordsFailed == 0)
                                        _app.uxLog(`Job# [${b.jobId}] (sObject ${task.sObjectName}) progress: ${b.numberRecordsProcessed} records, failed ${b.numberRecordsFailed}, error: ${b.error}.`);
                                    else {
                                        errorMessage = `Job# [${b.jobId}] (sObject ${task.sObjectName}) progress: ${b.numberRecordsProcessed} records, failed ${b.numberRecordsFailed}, error: ${b.error}.`;
                                    }
                                }
                            }
                        });
                    if (errorMessage) {
                        throw new Error(errorMessage);
                    }
                } catch (e) {
                    if (!this.script.promptOnUpdateError)
                        throw new SfdmModels.JobError("Data update error: " + e + ".");
                    else {
                        var ans = await CommonUtils.promptUser(`Data update error. Continue the job (y/n)?`);
                        if (ans != 'y' && ans != 'yes') {
                            throw new SfdmModels.JobAbortedByUser("Data update error: " + e + ".");
                        }
                    }
                }

                // Build records External id map for the target
                let targetRecIds: List<string> = new List<string>();

                updatedRecords.ForEach(record => {
                    targetExtIdMap[record[task.scriptObject.externalId + "_source"] || record[task.scriptObject.externalId]] = record["Id"];
                    targetRecIds.Add(record["Id"]);
                });


                targetRecords = targetRecords.RemoveAll(x => targetRecIds.IndexOf(x["Id"]) >= 0);
                targetRecords.AddRange(updatedRecords.ToArray());
                task.targetRecordSet.set(SfdmModels.Enums.RECORDS_SET.Main, targetRecords);

                this.uxLog(`${strOper}ing target ${task.sObjectName} finished, total processed ${updatedRecords.Count()} records`);
                continue;

            } else {
                // Referenced fields

                let backwardsReferencedTaskFields = task.taskFields.Where(x => x.isParentTaskBefore);
                let fieldNamesToOmit = task.taskFields.Where(x =>
                    !(!x.isReference || x.externalIdTaskField && x.externalIdTaskField.isParentTaskBefore)
                ).Select(x => x.name);

                let missingParentValueOnTagetErrors = new Map<string, number>();

                for (let i = 0, count = backwardsReferencedTaskFields.Count(); i < count; i++) {
                    let taskField = backwardsReferencedTaskFields.ElementAt(i);
                    let fieldToUpdate = taskField.originalScriptField.name;
                    let targetExtIdMap = taskField.parentTaskField.task.targetRecordSet.get(SfdmModels.Enums.RECORDS_SET.ExtIdMap).ElementAt(0);
                    let isRecordTypeField = taskField.parentTaskField.task.sObjectName == "RecordType";
                    let nullValue = null;
                    if (isRecordTypeField) {
                        nullValue = targetExtIdMap[Object.keys(targetExtIdMap).filter(key => key.startsWith(task.sObjectName))[0]];
                    }
                    sourceRecords.ForEach(record => {
                        if (record.hasOwnProperty(taskField.name) && !record[taskField.name]) {
                            record[fieldToUpdate] = nullValue;
                        } else {
                            var value = !isRecordTypeField ? targetExtIdMap[record[taskField.name]] : targetExtIdMap[task.sObjectName + ";" + record[taskField.name]];
                            if (!value) {
                                let m: Map<string, IMissingParentRecordsErrorRow> = csvDataCacheMap.get(missingParentRecordsErrorsFilePath);
                                m.set(record["Id"], {
                                    "Child record Id": record["Id"],
                                    "Child sObject": task.sObjectName,
                                    "Child external Id field" : taskField.name,
                                    "Parent external Id field": taskField.originalScriptField.externalId,
                                    "Parent sObject": taskField.parentTaskField.task.sObjectName,
                                    "Missing external Id value": record.hasOwnProperty(taskField.name) ? record[taskField.name] : `FIELD ${taskField.name} IS MISSING IN THE SOURCE RECORD`                                    
                                });
                                missingParentValueOnTagetErrors.set(taskField.name, (missingParentValueOnTagetErrors.get(taskField.name) || 0) + 1);
                                delete record[fieldToUpdate];
                            }
                            else {
                                record[fieldToUpdate] = value;
                            }
                        }
                    });
                }

                // Prompt to stop the entire job
                if (missingParentValueOnTagetErrors.size > 0) {

                    [...missingParentValueOnTagetErrors.keys()].forEach(key => {
                        this.uxLog(`[NOTE] sObject ${task.sObjectName}: found missing parent lookup records for the field ${key} in the TARGET org. The amount of the missing parent lookup records is: ${missingParentValueOnTagetErrors.get(key)} of total ${sourceRecords.Count()} records.`);
                    });
                    this.uxLog(`See ${SfdmModels.CONSTANTS.MISSING_PARENT_RECORDS_ERRORS_FILE_NAME} file for the details.`)

                    if (this.script.promptOnMissingParentObjects) {
                        var ans = await CommonUtils.promptUser(`Continue the job (y/n)?`);
                        if (ans != 'y' && ans != 'yes') {
                            await writeallErrorReportsToCSVFiles();
                            throw new SfdmModels.JobAbortedByUser("Missing parent records");
                        }
                    }

                }

                let updatedRecords: List<Object>;
                try {
                    let isChildTask = task.job.tasks.Any(x => !!x.scriptObject.referencedScriptObjectsMap.get(task.sObjectName));
                    let errorMessage = "";
                    // Update target records                      
                    updatedRecords = await SfdxUtils.processTaskDataAsync(task,
                        sourceRecords, targetRecords,
                        this.targetOrg, task.scriptObject.operation,
                        isChildTask,
                        fieldNamesToOmit.ToArray(), task.scriptObject.readonlyExternalIdFields, function (a, b) {
                            if (b) {
                                if (b.message) {
                                    _app.uxLog(b.message)
                                } else {
                                    if (b.numberRecordsFailed == 0)
                                        _app.uxLog(`Job# [${b.jobId}] (sObject ${task.sObjectName}) progress: ${b.numberRecordsProcessed} records, failed ${b.numberRecordsFailed}, error: ${b.error}.`);
                                    else {
                                        errorMessage = `Job# [${b.jobId}] (sObject ${task.sObjectName}) progress: ${b.numberRecordsProcessed} records, failed ${b.numberRecordsFailed}, error: ${b.error}.`;
                                    }
                                }
                            }
                        });
                    if (errorMessage) {
                        await writeallErrorReportsToCSVFiles();
                        throw new Error(errorMessage);
                    }
                } catch (e) {
                    await writeallErrorReportsToCSVFiles();
                    if (!this.script.promptOnUpdateError)
                        throw new SfdmModels.JobError("Data update error: " + e + ".");
                    else {
                        var ans = await CommonUtils.promptUser(`Data update error. Continue the job (y/n)?`);
                        if (ans != 'y' && ans != 'yes') {
                            throw new SfdmModels.JobAbortedByUser("Data update error: " + e + ".");
                        }
                    }
                }

                // Build records External id map for the target
                let targetRecIds: List<string> = new List<string>();
                let updatedRecordsMap: Map<string, object> = new Map<string, object>();

                updatedRecords.ForEach(record => {
                    targetExtIdMap[record[task.scriptObject.externalId + "_source"] || record[task.scriptObject.externalId]] = record["Id"];
                    targetRecIds.Add(record["Id"]);
                    updatedRecordsMap.set(record["Id"], record);
                });

                targetRecords.Where(x => targetRecIds.IndexOf(x["Id"]) >= 0).ForEach(record => {
                    var updatedRecord = updatedRecordsMap.get(record["Id"]);
                    updatedRecords.Remove(updatedRecord);
                    Object.keys(record).forEach(key => {
                        let val = updatedRecord[key];
                        if (!fieldNamesToOmit.Contains(key)) {
                            record[key] = val;
                        }
                    });
                });

                targetRecords.AddRange(updatedRecords.ToArray());
                this.uxLog(`${strOper}ing target sObject ${task.sObjectName} finished. Total processed ${updatedRecords.Count()} records.`);
            }
        }
        this.uxLog("STEP 4 has finished.");







        // ---------------------------------
        // ---------------------------------
        // ---------------------------------
        // ---------------------------------
        // 5 step. Update target records - backward order
        this.uxLog("");
        this.uxLog("STEP 5. Updating target (second run).");
        if (this.targetOrg.mediaType == SfdmModels.Enums.DATA_MEDIA_TYPE.Org) {
            for (let i = 0; i < this.job.tasks.Count(); i++) {

                let task = this.job.tasks.ElementAt(i);

                if (task.scriptObject.operation == SfdmModels.Enums.OPERATION.Readonly
                    || task.scriptObject.operation == SfdmModels.Enums.OPERATION.Delete) continue;


                let forwardsReferencedTaskFields = task.taskFields
                    .Where(x => x.externalIdTaskField && !x.externalIdTaskField.isParentTaskBefore)
                    .Select(x => x.externalIdTaskField);

                if (forwardsReferencedTaskFields.Count() > 0) {

                    let fieldNamesToOmit = task.taskFields.Where(x =>
                        !(x.externalIdTaskField && !x.externalIdTaskField.isParentTaskBefore) && x.name != "Id"
                    ).Select(x => x.name);

                    this.uxLog(`Updating target sObject ${task.sObjectName}...`);

                    let sourceRecords = task.sourceRecordSet.get(SfdmModels.Enums.RECORDS_SET.Main);
                    let targetRecords = task.targetRecordSet.get(SfdmModels.Enums.RECORDS_SET.Main);

                    let missingParentValueOnTagetErrors = new Map<string, number>();

                    for (let i = 0, count = forwardsReferencedTaskFields.Count(); i < count; i++) {
                        let taskField = forwardsReferencedTaskFields.ElementAt(i);
                        let fieldToUpdate = taskField.originalScriptField.name;
                        let targetExtIdMap = taskField.parentTaskField.task.targetRecordSet.get(SfdmModels.Enums.RECORDS_SET.ExtIdMap).ElementAt(0);
                        let nullValue = null;
                        sourceRecords.ForEach(record => {
                            if (record.hasOwnProperty(taskField.name) && !record[taskField.name]) {
                                record[fieldToUpdate] = nullValue;
                            } else {
                                var value = targetExtIdMap[record[taskField.name]];
                                if (!value) {
                                    let m: Map<string, IMissingParentRecordsErrorRow> = csvDataCacheMap.get(missingParentRecordsErrorsFilePath);
                                    m.set(record["Id"], {
                                        "Child record Id": record["Id"],
                                        "Child sObject": task.sObjectName,
                                        "Child external Id field" : taskField.name,
                                        "Parent external Id field": taskField.originalScriptField.externalId,
                                        "Parent sObject": taskField.parentTaskField.task.sObjectName,
                                        "Missing external Id value": record.hasOwnProperty(taskField.name) ? record[taskField.name] : `FIELD ${taskField.name} IS MISSING IN THE SOURCE RECORD`                                        
                                    });
                                    missingParentValueOnTagetErrors.set(taskField.name, (missingParentValueOnTagetErrors.get(taskField.name) || 0) + 1);
                                    delete record[fieldToUpdate];
                                }
                                else {
                                    record[fieldToUpdate] = value;
                                }
                            }
                        });
                    }

                    // Prompt to stop the entire job
                    if (missingParentValueOnTagetErrors.size > 0) {
                        [...missingParentValueOnTagetErrors.keys()].forEach(key => {
                            this.uxLog(`[NOTE] sObject ${task.sObjectName}: found missing parent lookup records for the field ${key} in the TARGET org. The amount of the missing parent lookup records is: ${missingParentValueOnTagetErrors.get(key)} of total ${sourceRecords.Count()} records.`);
                        });
                        this.uxLog(`See ${SfdmModels.CONSTANTS.MISSING_PARENT_RECORDS_ERRORS_FILE_NAME} file for the details.`)

                        if (this.script.promptOnMissingParentObjects) {
                            var ans = await CommonUtils.promptUser(`Continue the job (y/n)?`);
                            if (ans != 'y' && ans != 'yes') {
                                await writeallErrorReportsToCSVFiles();
                                throw new SfdmModels.JobAbortedByUser("Missing parent records");
                            }
                        }
                    }

                    let updatedRecords: List<Object>;
                    try {
                        let isChildTask = task.job.tasks.Any(x => !!x.scriptObject.referencedScriptObjectsMap.get(task.sObjectName));
                        let errorMessage = "";
                        // Update target records                      
                        updatedRecords = await SfdxUtils.processTaskDataAsync(task,
                            sourceRecords, targetRecords,
                            this.targetOrg,
                            SfdmModels.Enums.OPERATION.Update,
                            isChildTask,
                            fieldNamesToOmit.ToArray(), task.scriptObject.readonlyExternalIdFields, function (a, b) {
                                if (b) {
                                    if (b.message) {
                                        _app.uxLog(b.message)
                                    } else {

                                        if (b.numberRecordsFailed == 0)
                                            _app.uxLog(`Job# [${b.jobId}] (sObject ${task.sObjectName}) progress: ${b.numberRecordsProcessed} records, failed ${b.numberRecordsFailed}, error: ${b.error}.`);
                                        else {
                                            errorMessage = `Job# [${b.jobId}] (sObject ${task.sObjectName}) progress: ${b.numberRecordsProcessed} records, failed ${b.numberRecordsFailed}, error: ${b.error}.`;
                                        }
                                    }
                                }
                            });
                        if (errorMessage) {
                            await writeallErrorReportsToCSVFiles();
                            throw new Error(errorMessage);
                        }
                    } catch (e) {
                        await writeallErrorReportsToCSVFiles();
                        if (!this.script.promptOnUpdateError)
                            throw new SfdmModels.JobError("Data update error: " + e + ".");
                        else {
                            var ans = await CommonUtils.promptUser(`Data update error. Continue the job (y/n)?`);
                            if (ans != 'y' && ans != 'yes') {
                                throw new SfdmModels.JobAbortedByUser("Data update error: " + e + ".");
                            }
                        }
                    }

                    this.uxLog(`Updating target ${task.sObjectName} finished. Total processed ${updatedRecords.Count()} records.`);
                }

            }
        }
        this.uxLog("STEP 5 has finished.");


        await writeallErrorReportsToCSVFiles();

        this.uxLog("");
        this.uxLog("sfdmu:move command has completed.");
        this.uxLog("");


        // Helper functions
        async function writeallErrorReportsToCSVFiles(): Promise<any> {
            // Write all error reports to CSV files
            for (let index = 0; index < extendedErrorFilePaths.length; index++) {
                const filepath = extendedErrorFilePaths[index];
                let m = csvDataCacheMap.get(filepath);
                if (m) {
                    _app.uxLog(`Writing to ${filepath}...`);
                    let values = [...m.values()];
                    await CommonUtils.writeCsvFile(filepath, values, true);
                }
            }
        }

    }



}












