const {
  Route53Client,
  ListHostedZonesByNameCommand,
  ChangeResourceRecordSetsCommand,
  CreateHostedZoneCommand,
} = require("@aws-sdk/client-route-53");

const getR53 = () => new Route53Client({ region: "us-east-1" });

const getHZoneNameFromDomain = (domain) =>
  domain.split(".").slice(-2).join(".");

const findHostedZoneForDomain = async (r53, domain) => {
  const hZoneName = getHZoneNameFromDomain(domain);
  const { HostedZones } = await r53.send(
    new ListHostedZonesByNameCommand({ DNSName: hZoneName })
  );
  const matchingHostedZones = HostedZones.filter(
    ({ Name }) =>
      Name === hZoneName ||
      Name === (hZoneName + "." || Name + "." === hZoneName)
  );
  if (matchingHostedZones.length === 1) {
    return matchingHostedZones[0];
  }
  if (matchingHostedZones.length > 1) {
    throw new Error(
      "Found multiple matching hosted zones, could not figure out which one to use:" +
        JSON.stringify(matchingHostedZones, undefined, 2)
    );
  }
  return false;
};

const createHostedZone = async (r53, domain) => {
  const hZoneName = getHZoneNameFromDomain(domain);
  return await r53.send(
    new CreateHostedZoneCommand({
      CallerReference: Date.now(),
      Name: hZoneName,
    })
  );
};

const hostedZoneIdsForS3 = {
  "us-east-2": "Z2O1EMRO9K5GLX",
  "us-east-1": "Z3AQBSTGFYJSTF",
  "us-west-1": "Z2F56UZL2M1ACD",
  "us-west-2": "Z3BJ6K6RIION7M",
  "af-south-1": "Z11KHD8FBVPUYU",
  "ap-east-1": "ZNB98KWMFR0R6",
  "ap-south-1": "Z11RGJOFQNVJUP",
  "ap-northeast-3": "Z2YQB5RD63NC85",
  "ap-northeast-2": "Z3W03O7B5YMIYP",
  "ap-southeast-1": "Z3O0J2DXBE1FTB",
  "ap-southeast-2": "Z1WCIGYICN2BYD",
  "ap-northeast-1": "Z2M4EHUR26P7ZW",
  "ca-central-1": "Z1QDHH18159H29",
  "cn-northwest-1": ".cn Not supported",
  "eu-central-1": "Z21DNDUVLTQW6Q",
  "eu-west-1": "Z1BKCTXD74EZPE",
  "eu-west-2": "Z3GKZC51ZF0DB4",
  "eu-south-1": "Not supported",
  "eu-west-3": "Z3R1K369G5AVDG",
  "eu-north-1": "Z3BAZG2TWCNX0D",
  "sa-east-1": "Z7KQH4QJS55SO",
  "us-gov-east-1": "Z2NIFVYYW2VKV1",
  "us-gov-west-1": "Z31GFT0UA1I2HV",
};
const cfHostedZoneId = "Z2FDTNDATAQYW2";
const setDNSValues = async (r53, hostedZoneId, records, force = false) => {
  const options = {
    HostedZoneId: hostedZoneId,
    ChangeBatch: {
      Changes: records.map((record) => {
        if (record.ResourceRecords && !record.TTL) {
          record.TTL = 300;
        }
        if (record.AliasTarget && !record.AliasTarget.HostedZoneId) {
          const m = /\.s3-website\.([^.]+)\.amazonaws.com\.?$/.exec(
            record.AliasTarget.DNSName
          );
          if (m) {
            record.AliasTarget.HostedZoneId = hostedZoneIdsForS3[m[1]];
          } else if (/\.cloudfront\.net\.?$/.test(record.AliasTarget.DNSName)) {
            record.AliasTarget.HostedZoneId = cfHostedZoneId;
          } else {
            throw new Error(
              "AliasTarget.HostedZoneId missing and cannot be automatically guessed."
            );
          }
        }
        return {
          Action: force ? "UPSERT" : "CREATE",
          ResourceRecordSet: record,
        };
      }),
    },
  };
  await r53.send(new ChangeResourceRecordSetsCommand(options));
};

module.exports = {
  getR53,
  findHostedZoneForDomain,
  createHostedZone,
  setDNSValues,
  getHZoneNameFromDomain,
};
