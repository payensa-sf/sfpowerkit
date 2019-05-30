
import { AnyJson } from '@salesforce/ts-types';
import fs from 'fs-extra';
import { core, flags, SfdxCommand } from '@salesforce/command';
import rimraf = require('rimraf');
import { RetrieveResultLocator, AsyncResult, Callback, AsyncResultLocator, Connection, RetrieveResult, SaveResult, DeployResult } from 'jsforce';
import { AsyncResource } from 'async_hooks';
import { SfdxError } from '@salesforce/core';
import xml2js = require('xml2js');
import util = require('util');
// tslint:disable-next-line:ordered-imports
var jsforce = require('jsforce');
var path = require('path')
var unzipper = require('unzipper')
var archiver = require('archiver');



// Initialize Messages with the current plugin directory
core.Messages.importMessagesDirectory(__dirname);

// Load the specific messages for this file. Messages from @salesforce/command, @salesforce/core,
// or any library that is using the messages framework can also be loaded this way.
const messages = core.Messages.loadMessages('sfpowerkit', 'duplicaterule_deactivate');


export default class Deactivate extends SfdxCommand {

  public connectedapp_consumerKey: string;
  public static description = messages.getMessage('commandDescription');

  public static examples = [
    `$ sfdx  sfpowerkit:org:duplicaterule:deactivate -n Account.CRM_Account_Rule_1 -u sandbox
    Polling for Retrieval Status
    Retrieved Duplicate Rule  with label : CRM Account Rule 2
    Preparing Deactivation
    Deploying Deactivated Rule with ID  0Af4Y000003OdTWSA0
    Polling for Deployment Status
    Polling for Deployment Status
    Duplicate Rule CRM Account Rule 2 deactivated
  `
  ];


  protected static flagsConfig = {
    name: flags.string({ required: true, char: 'n', description: messages.getMessage('nameFlagDescription') }),

  };


  // Comment this out if your command does not require an org username
  protected static requiresUsername = true;

  public async run(): Promise<AnyJson> {

    rimraf.sync('temp_sfpowerkit');


    //Connect to the org
    await this.org.refreshAuth();
    const conn = this.org.getConnection();
    const apiversion = await conn.retrieveMaxApiVersion();

    let retrieveRequest = {
      apiVersion: apiversion
    };




    //Retrieve Duplicate Rule
    retrieveRequest['singlePackage'] = true;
    retrieveRequest['unpackaged'] = { types: { name: 'DuplicateRule', members: this.flags.name } };
    conn.metadata.pollTimeout = 60;
    let retrievedId;
    await conn.metadata.retrieve(retrieveRequest, function (error, result: AsyncResult) {
      if (error) { return console.error(error); }
      retrievedId = result.id;
    });

    let metadata_retrieve_result = await this.checkRetrievalStatus(conn, retrievedId);
    if (!metadata_retrieve_result.zipFile)
      throw new SfdxError("Unable to find the requested Duplicate Rule");


    //Extract Duplicate Rule
    var zipFileName = "temp_sfpowerkit/unpackaged.zip";
    fs.mkdirSync('temp_sfpowerkit');
    fs.writeFileSync(zipFileName, metadata_retrieve_result.zipFile, { encoding: 'base64' });
    await extract('temp_sfpowerkit');
    fs.unlinkSync(zipFileName);
    let resultFile = `temp_sfpowerkit/duplicateRules/${this.flags.name}.duplicateRule`;



    if (fs.existsSync(path.resolve(resultFile))) {
      const parser = new xml2js.Parser({ explicitArray: false });
      const parseString = util.promisify(parser.parseString);

      let retrieved_duplicaterule = await parseString(fs.readFileSync(path.resolve(resultFile)));


      this.ux.log(`Retrieved Duplicate Rule  with label : ${retrieved_duplicaterule.DuplicateRule.masterLabel}`);


      //Do Nothing if its already inactive
      if(retrieved_duplicaterule.DuplicateRule.isActive === "false")
      {
        this.ux.log("Already Inactive, exiting");
        return { 'status': 1 };

      } 
      //Deactivate Rule
      this.ux.log(`Preparing Deactivation`);
      retrieved_duplicaterule.DuplicateRule.isActive = "false";
      let builder = new xml2js.Builder();
      var xml = builder.buildObject(retrieved_duplicaterule);
      fs.writeFileSync(resultFile, xml);


      var zipFile = 'temp_sfpowerkit/package.zip';
      await zipDirectory('temp_sfpowerkit', zipFile);



      //Deploy Rule
      conn.metadata.pollTimeout = 300;
      let deployId: AsyncResult;

      var zipStream = fs.createReadStream(zipFile);
      await conn.metadata.deploy(zipStream, { rollbackOnError: true, singlePackage: true }, function (error, result: AsyncResult) {
        if (error) { return console.error(error); }
        deployId = result;
      });

      this.ux.log(`Deploying Deactivated Rule with ID  ${deployId.id}`);
      let metadata_deploy_result: DeployResult = await this.checkDeploymentStatus(conn, deployId.id);

      if (!metadata_deploy_result.success)
        throw new SfdxError("Unable to deploy the deactivated rule");

      this.ux.log(`Duplicate Rule ${retrieved_duplicaterule.DuplicateRule.masterLabel} deactivated`);

     
      return { 'status': 1 };

    }
    else {
      throw new SfdxError("Duplicate Rule not found in the org")

    }



  }

  public async  delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }


  private async checkDeploymentStatus(conn: Connection, retrievedId: string): Promise<DeployResult> {
    let metadata_result;

    while (true) {
      await conn.metadata.checkDeployStatus(retrievedId, true, function (error, result) {
        if (error) {
          return console.error(error);
        }
        metadata_result = result
      });


      if (!metadata_result.done) {
        this.ux.log(`Polling for Deployment Status`)
        await (this.delay(5000));
      }
      else {
        break;
      }

    }
    return metadata_result;
  }


  private async checkRetrievalStatus(conn: Connection, retrievedId: string) {
    let metadata_result

    while (true) {
      await conn.metadata.checkRetrieveStatus(retrievedId, function (error, result) {
        if (error) { return console.error(error); }
        metadata_result = result
      });

      if (metadata_result.done === "false") {

        this.ux.log(`Polling for Retrieval Status`)
        await (this.delay(5000));
      }
      else {
        //this.ux.logJson(metadata_result);
        break;
      }

    }
    return metadata_result;
  }


}

const extract = (location: string) => {
  return new Promise((resolve, reject) => {
    fs.createReadStream(`./${location}/unpackaged.zip`)
      .pipe(unzipper.Extract({ path: `${location}` }))
      .on('close', () => {
        resolve();
      })
      .on('error', error => reject(error));
  });
};

const zipDirectory = (source, out) => {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const stream = fs.createWriteStream(out);

  return new Promise((resolve, reject) => {
    archive
      .directory(source, false)
      .on('error', err => reject(err))
      .pipe(stream)
      ;

    stream.on('close', () => resolve());
    archive.finalize();
  });
};



