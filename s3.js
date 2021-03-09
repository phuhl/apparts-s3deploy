const {
  S3Client,
  CreateBucketCommand,
  ListBucketsCommand,
  PutBucketWebsiteCommand,
  PutPublicAccessBlockCommand,
} = require("@aws-sdk/client-s3");

const getS3 = (params) => new S3Client(params);

const getBuckets = async (s3) => {
  return await s3.send(new ListBucketsCommand({}));
};

const bucketExists = (buckets, name) => {
  return buckets.filter(({ Name }) => Name === name).length > 0;
};

const createBucket = async (s3, name) => {
  return await s3.send(new CreateBucketCommand({ Bucket: name }));
};

const makeBucketRedirectTo = async (s3, name, to, protocol = "https") => {
  return await s3.send(
    new PutBucketWebsiteCommand({
      Bucket: name,
      WebsiteConfiguration: {
        RedirectAllRequestsTo: {
          Protocol: protocol,
          HostName: to,
        },
      },
    })
  );
};

const setBucketPublicAccess = async (s3, name, isPublic) => {
  return await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: name,
      PublicAccessBlockConfiguration: {
        RestrictPublicBuckets: !isPublic,
        BlockPublicAcls: !isPublic,
        BlockPublicPolicy: !isPublic,
        IgnorePublicAcls: !isPublic,
      },
    })
  );
};

module.exports = {
  getS3,
  getBuckets,
  bucketExists,
  createBucket,
  makeBucketRedirectTo,
  setBucketPublicAccess,
};
