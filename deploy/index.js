#!/usr/bin/env node
const AWS = require("aws-sdk");
const s3 = new AWS.S3();
const path = require("path");
const fs = require("fs/promises");
const { gzip } = require("node-gzip");
const mime = require("mime-types");
const crypto = require("crypto");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const argv = yargs(hideBin(process.argv))
  .command("$0", "", (yargs) =>
    yargs
      .positional("s3bucket", {
        description: "The bucket name to upload to.",
        type: "string",
      })
      .positional("local path", {
        description: "Directory that should be uploaded.",
        type: "string",
      })
      .usage("$0 <s3bucket> <local path>")
  )
  .option("forceupload", {
    alias: "f",
    type: "boolean",
    description: "Upload, even when file with same MD5 hash already exists.",
  })
  .option("prune", {
    alias: "p",
    type: "boolean",
    description:
      "Prune S3 bucket, aka. delete all files from the bucket that were not found in the local directory.",
  })
  .option("dontdelete", {
    description:
      "Files or folders that should be ignored when pruning the S3 bucket.",
    type: "array",
  })
  .option("no-cache", {
    description: "Disable Cache-Control headers entirely.",
    type: "boolean",
  })
  .option("cache-duration", {
    description:
      "The seconds for the Cache-Control header of static files. Default is 31536000 (1 year)",
    type: "number",
  })

  .scriptName("npx @apparts/s3deploy")
  .help()
  .alias("help", "h").argv;

const {
  _: [bucketName, localPath],
  forceupload: forceUpload,
  dontdelete = [],
  prune,
  "cache-duration": cacheDuration = 31536000,
  "no-cache": noCache,
} = argv;

// font, image, media file, script, or stylesheet.
const fileEndingsForCacheControl = [
  "application/x-javascript",
  "text/javascript",
  "text/css",
  "application/vnd.ms-fontobject",
  "app/vdn.ms-fontobject",
  "application/x-font-ttf",
  "image/.*",
  "video/.*",
  "font/.*",
];
const regExpForCacheControl = new RegExp(fileEndingsForCacheControl.join("|"));

const fileEndingsForCompression = [
  "text/plain",
  "text/html",
  "text/javascript",
  "text/css",
  "text/xml",
  "application/javascript",
  "application/x-javascript",
  "application/xml",
  "text/x-component",
  "application/json",
  "application/xhtml+xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/vnd.ms-fontobject",
  "app/vdn.ms-fontobject",
  "image/svg+xml",
  "application/x-font-ttf",
  "font/opentype",
  "application/octet-stream",
];

const walkDirectory = async (currentDir) => {
  const content = (await fs.readdir(currentDir)).map((name) =>
    path.join(currentDir, name)
  );
  const stats = await Promise.all(content.map((file) => fs.stat(file)));
  const files = content.filter((_, i) => stats[i].isFile());
  const directories = content.filter((_, i) => !stats[i].isFile());
  const subFiles = await Promise.all(
    directories.map((dir) => walkDirectory(dir))
  );
  return files.concat(...subFiles);
};

const getKeyForFile = (filePath, localPath) =>
  filePath.substring(localPath.length - 1);

const getParamsForFile = async (filePath, bucketName, localPath) => {
  const key = getKeyForFile(filePath, localPath);
  const contentType = mime.lookup(key) || "application/octet-stream";
  return {
    Bucket: bucketName,
    Key: key,
    Body: await fs.readFile(filePath),
    ContentType: contentType,
    ...(!noCache && contentType.match(regExpForCacheControl)
      ? { CacheControl: "" + cacheDuration }
      : {}),
  };
};

const compress = async (params) => {
  if (fileEndingsForCompression.indexOf(params.ContentType) !== -1) {
    const newData = await gzip(params.Body);
    return {
      ...params,
      Body: newData,
      ContentEncoding: "gzip",
    };
  } else {
    return params;
  }
};

const getS3Files = (bucketName, _ctoken) => {
  return new Promise((res, rej) => {
    console.log("Listing bucket objects");
    s3.listObjectsV2(
      { Bucket: bucketName, ContinuationToken: _ctoken },
      async (err, data) => {
        if (err) {
          rej(err);
        }
        if (data.IsTruncated) {
          res(
            data.Contents.concat(
              await getS3Files(bucketName, data.NextContinuationToken)
            )
          );
        } else {
          res(data.Contents);
        }
      }
    );
  });
};

const matchesOnlineVersion = (params, onlineFiles) => {
  const md5 = crypto.createHash("md5").update(params.Body).digest("hex");

  const exists = onlineFiles.filter(({ Key }) => Key === params.Key)[0];
  const matches = exists && exists.ETag === `"${md5}"`;
  if (!exists || forceUpload) {
    return "Uploaded";
  } else if (!matches) {
    return "Updated";
  } else {
    return "Skipped";
  }
};

const upload = (params) => {
  return new Promise((res, rej) => {
    s3.putObject(params, function (err, data) {
      if (err) {
        rej(err);
      } else {
        res();
      }
    });
  });
};

let counter = 0;
const uploadFile = async (file, onlineFiles) => {
  const params = await getParamsForFile(file, bucketName, localPath);
  const compressed = await compress(params);
  const action = await matchesOnlineVersion(compressed, onlineFiles);
  if (action !== "Skipped") {
    await upload(compressed);
  }
  counter++;
  console.log(counter, action, params.Key);
  return { ...params, action };
};

const delete1k = (s3Files, bucketName) => {
  const batch = s3Files.slice(0, 1000);
  return new Promise((res, rej) => {
    s3.deleteObjects(
      {
        Bucket: bucketName,
        Delete: {
          Objects: batch.map(({ Key }) => ({ Key })),
        },
      },
      async (err, data) => {
        if (err) {
          rej(err);
        } else {
          let subRes = [];
          if (s3Files.length > 1000) {
            subRes = await delete1k(s3Files.slice(1000), bucketName);
          }
          res([
            ...data.Deleted.map(({ Key }) => ({
              status: "fulfilled",
              value: { Key, action: "Deleted" },
            })),
            ...data.Errors.map(({ Key, Code }) => ({
              status: "rejected",
              reason: { Key, Code, message: "deletion failed" },
            })),
            ...subRes,
          ]);
        }
      }
    );
  });
};

const pruneS3 = (s3Files, localFiles, localPath, bucketName) => {
  const keys = localFiles.map((file) => getKeyForFile(file, localPath));
  let toBeDeleted = s3Files
    .filter(({ Key }) => keys.indexOf(Key) === -1)
    .filter(
      ({ Key }) =>
        !dontdelete.reduce(
          (a, b) =>
            a ||
            (b.substr(-1) === path.sep
              ? b === Key.substr(0, b.length)
              : Key === b),
          false
        )
    );
  console.log("Found", toBeDeleted.length, "files to be deleted.\n\n");
  if (toBeDeleted.length > 0) {
    return delete1k(toBeDeleted, bucketName);
  }
  return Promise.resolve([]);
};

const printStats = (results, action, onError) => {
  const files = results.filter(({ status, value: { action: a } = {} }) =>
    status === "fulfilled" ? a === action : onError
  );
  if (files.length > 0) {
    console.log(`\n\n--- ${action} files: ------------------`);
    if (onError) {
      console.log(files.map(({ reason }) => reason).join("\n"), "\n");
    } else {
      console.log(files.map(({ value: { Key } }) => Key).join("\n"), "\n");
    }
  }
  console.log(files.length, `files have ${action.toLowerCase()}\n`);
};

const uploadDir = async (bucketName, localPath) => {
  const allFiles = await walkDirectory(localPath);
  console.log("Found", allFiles.length, "local files.\n\n");

  const onlineFiles =
    ((!forceUpload || prune) && (await getS3Files(bucketName))) || [];
  console.log("Found", onlineFiles.length, "online files.\n\n");

  const results = await Promise.allSettled(
    allFiles.map((file) => uploadFile(file, onlineFiles))
  );

  let deletionResults = [];
  if (prune) {
    deletionResults = await pruneS3(
      onlineFiles,
      allFiles,
      localPath,
      bucketName
    );
  }

  printStats(results, "Skipped");
  printStats(results, "Uploaded");
  printStats(results, "Updated");
  if (prune) {
    printStats(deletionResults, "Deleted");
  }
  printStats([...results, ...deletionResults], "Error", true);
};

uploadDir(bucketName, localPath).catch((err) => console.log("ERROR:", err));
