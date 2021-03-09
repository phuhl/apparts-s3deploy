const {
  CloudFrontClient,
  CreateCloudFrontOriginAccessIdentityCommand,
  CreateDistributionCommand,
} = require("@aws-sdk/client-cloudfront");

const getCF = () => new CloudFrontClient({ region: "us-east-1" });

const createOriginAccessIdentity = async (cf, name) => {
  return await cf.send(
    new CreateCloudFrontOriginAccessIdentityCommand({
      CloudFrontOriginAccessIdentityConfig: {
        CallerReference: Date.now(),
        Comment: "access-identity-" + name,
      },
    })
  );
};

const createCloudFrontDistribution = async (
  cf,
  {
    domain,
    altNames,
    isSPA,
    s3Name,
    cfOAIId,
    region,
    certificateArn,
    priceClass,
  }
) => {
  let CustomErrorResponses;
  if (isSPA) {
    CustomErrorResponses = {
      Items: [
        {
          ErrorCode: 403,
          ResponsePagePath: "/index.html",
          ResponseCode: 200,
          ErrorCachingMinTTL: 100000,
        },
      ],
    };
  }
  const Aliases = {
    Items: [domain, ...(altNames || [])],
    Quantity: [domain, ...(altNames || [])].length,
  };
  return await cf.send(
    new CreateDistributionCommand({
      DistributionConfig: {
        CallerReference: Date.now(),
        Comment: "",
        DefaultCacheBehavior: {
          TargetOriginId: s3Name,
          ViewerProtocolPolicy: "redirect-to-https",
          CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
        },
        ViewerCertificate: {
          ACMCertificateArn: certificateArn,
          SSLSupportMethod: "sni-only",
          MinimumProtocolVersion: "TLSv1",
        },
        Aliases,
        DefaultRootObject: "index.html",
        Enabled: true,
        CustomErrorResponses,
        PriceClass: ["PriceClass_100", "PriceClass_200", "PriceClass_All"][
          priceClass
        ],
        // TODO: Logging
        Origins: {
          Items: [
            {
              DomainName: `${s3Name}.s3.${region}.amazonaws.com`,
              Id: s3Name,
              S3OriginConfig: {
                OriginAccessIdentity:
                  "origin-access-identity/cloudfront/" + cfOAIId,
              },
            },
          ],
          Quantity: 1,
        },
      },
    })
  );
};

module.exports = {
  getCF,
  createOriginAccessIdentity,
  createCloudFrontDistribution,
};
