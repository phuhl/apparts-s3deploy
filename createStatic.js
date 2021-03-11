#!/usr/bin/env node
const stdin = process.openStdin();
const { stdout } = process;
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const chalk = require("chalk");

const {
  getS3,
  getBuckets,
  bucketExists,
  createBucket,
  makeBucketRedirectTo,
  setBucketPublicAccess,
} = require("./s3");
const {
  getACM,
  createCertificate,
  getCertValidationOptions,
  waitForCertValidation,
  isCertificateValidated,
} = require("./acm");
const {
  getR53,
  findHostedZoneForDomain,
  createHostedZone,
  setDNSValues,
  getHZoneNameFromDomain,
  hasDNSValue,
} = require("./r53");
const {
  getCF,
  createOriginAccessIdentity,
  createCloudFrontDistribution,
  getCloudFrontDistribution,
} = require("./cf");

const info = chalk.green("i");
const warning = chalk.yellow("WARNING:");

const main = async ({
  domain,
  region,
  s3Name,
  certAltNames,
  isSPA,
  priceClass,
  skipCreateS3,
  skipCreateWwwS3,
  useCertificate,
  useDistribution,
  noWww,
}) => {
  if (region === "me-south-1") {
    throw new Error(
      `Sorry, but me-south-1 is literally the only not-supported region!`
    );
  }

  const s3 = getS3({ region });
  const acm = getACM();
  const r53 = getR53();
  const cf = getCF();

  const summary = [];

  console.log(info, `Checking hosted zones.`);
  let hZone = await findHostedZoneForDomain(r53, domain);
  if (!hZone) {
    console.log(`${warning} Hosted zone ${domain} does not exist.`);

    const answer = await askQuestion(`Should it be created? [y/N]`);
    if (isDefaultNo(answer)) {
      return;
    }
  } else {
    console.log(info, `Checking DNS entries.`);
    if (await hasDNSValue(r53, hZone.Id, "A", domain)) {
      console.log(
        `${warning} DNS A record for ${domain} exists. Overwriting it will make the current resource, served und that domain, unavailable.`
      );
      const answer = await askQuestion(`Overwrite the record anyways? [y/N]`);
      if (isDefaultNo(answer)) {
        return;
      }
    }
    if (await hasDNSValue(r53, hZone.Id, "AAAA", domain)) {
      console.log(
        `${warning} DNS AAAA record for ${domain} exists. Overwriting it will make the current resource, served und that domain, unavailable.`
      );
      const answer = await askQuestion(`Overwrite the record anyways? [y/N]`);
      if (isDefaultNo(answer)) {
        return;
      }
    }
    if (!noWww && (await hasDNSValue(r53, hZone.Id, "A", "www." + domain))) {
      console.log(
        `${warning} DNS A record for www.${domain} exists. Overwriting it will make the current resource, served und that domain, unavailable.`
      );
      const answer = await askQuestion(`Overwrite the record anyways? [y/N]`);
      if (isDefaultNo(answer)) {
        return;
      }
    }
  }

  if (
    (certAltNames || [])
      .map((d) => getHZoneNameFromDomain(d))
      .filter((d) => d !== getHZoneNameFromDomain(domain)).length > 0
  ) {
    throw new Error(
      "Sorry, currently alternative domains are only allowed when they are in the same hosted zone as the main domain"
    );
  }

  console.log(info, `Checking existing buckets.`);
  const { Buckets: buckets } = await getBuckets(s3);
  if (bucketExists(buckets, s3Name) && !skipCreateS3) {
    console.log(
      chalk.red("ERROR:"),
      `S3 bucket ${chalk.green(s3Name)} already exists, aborting!`
    );
    return;
  }
  if (bucketExists(buckets, "www." + s3Name) && !skipCreateWwwS3 && !noWww) {
    console.log(
      chalk.red("ERROR:"),
      `S3 bucket ${chalk.green("www." + s3Name)} already exists, aborting!`
    );
    return;
  }

  let validateCert = true;
  if (useCertificate) {
    console.log(info, `Checking certificate.`);
    validateCert = !(await isCertificateValidated(acm, useCertificate));
    console.log(
      info,
      `Certificate has ${validateCert ? "to be" : "not to be"} validated.`
    );
  }

  let cfDistLocation;
  if (useDistribution) {
    console.log(info, `Checking CloudFront distribution.`);
    const {
      Distribution: { DomainName },
    } = await getCloudFrontDistribution(cf, useDistribution);
    cfDistLocation = DomainName;
  }

  const toBeCreated = [];
  if (!skipCreateS3) {
    toBeCreated.push(`  - S3 bucket ${chalk.green(s3Name)}`);
  }
  if (!skipCreateWwwS3 && !noWww) {
    toBeCreated.push(`  - public S3 bucket ${chalk.green(
      "www." + s3Name
    )} with website that redirects
    to ${chalk.green("https://" + domain)}`);
  }
  if (!hZone) {
    toBeCreated.push(
      `  - hosted zone ${chalk.green(getHZoneNameFromDomain(domain))}`
    );
  }
  if (!useCertificate) {
    toBeCreated.push(
      `  - ACM certificate for ${chalk.green([domain, certAltNames || []])}`
    );
  }
  if (validateCert) {
    toBeCreated.push(
      `  - DNS CNAME records for validating certificate for ${chalk.green([
        domain,
        certAltNames || [],
      ])}`
    );
  }
  if (!useDistribution) {
    toBeCreated.push(`  - CloudFront origin access identity
  - CloudFront distribution for ${chalk.green([
    domain,
    certAltNames || [],
  ])} with
    - price class ${chalk.green(
      ["PriceClass_100", "PriceClass_200", "PriceClass_All"][priceClass]
    )}
    - ${chalk.green(isSPA ? "setup" : "not setup")} for a single page app
    - default root object ${chalk.green("index.html")}
    - SSL support method ${chalk.green("sni-only")}
    - a custom certificate for ${chalk.green([domain, certAltNames || []])}
    - cache policy ${chalk.green("Managed-CachingOptimized")}
    - the S3 bucket ${chalk.green(s3Name)} as origin`);
  }

  toBeCreated.push(`  - DNS A and AAAA records for ${chalk.green(domain)}`);
  if (!noWww) {
    toBeCreated.push(`  - DNS A record for ${chalk.green("www." + domain)}`);
  }
  console.log(info, "Creating");
  console.log(toBeCreated.join("\n"));
  console.log(info, "These changes might cause additional charges.");
  if (!isDefaultYes(await askQuestion(`Is this ok? [Y/n]`))) {
    console.log(info, "Aborted.");
    process.exit(1);
  }

  if (!skipCreateS3) {
    console.log(info, `Creating bucket with name ${chalk.green(s3Name)}`);
    await createBucket(s3, s3Name);
    console.log(info, `Created bucket ${s3Name}.`);
    summary.push({ created: "S3 bucket", id: s3Name });
  } else {
    summary.push({ reused: "S3 bucket", id: s3Name });
  }

  await setBucketPublicAccess(s3, s3Name, false);
  console.log(info, `Set bucket ${s3Name} private.`);

  if (!noWww) {
    if (!skipCreateWwwS3) {
      console.log(
        info,
        `Creating bucket with name ${chalk.green("www." + s3Name)}`
      );
      await createBucket(s3, "www." + s3Name);
      console.log(info, `Created bucket www.${s3Name}.`);
      summary.push({ created: "S3 bucket", id: "www." + s3Name });
    } else {
      summary.push({ reused: "S3 bucket", id: "www." + s3Name });
    }

    if (!skipCreateWwwS3) {
      await makeBucketRedirectTo(s3, "www." + s3Name, domain);
      console.log(
        info,
        `Set up redirection: bucket www.${s3Name} -> https://${domain}.`
      );
      await setBucketPublicAccess(s3, "www." + s3Name, true);
      console.log(info, `Set bucket www.${s3Name} public.`);
    }
  }

  if (!hZone) {
    const {
      HostedZone,
      DelegationSet: { NameServers },
    } = await createHostedZone(r53, domain);
    hZone = HostedZone;
    summary.push({ created: "Hosted zone", id: hZone.Id });
    console.log(info, `Created Hosted zone: ${hZone.Id}.`);
    console.log(
      info,
      `These are the used nameservers:\n${NameServers.join("\n")}`
    );
    console.log(
      info,
      `Please ${chalk.yellow(
        "update the nameservers at your domain provider manually"
      )}.`
    );
    await askQuestion(`Press any key to continue. [Enter]`);
  }
  const hostedZoneId = hZone.Id;

  let certificateArn = useCertificate;
  if (!useCertificate) {
    const { CertificateArn } = await createCertificate(
      acm,
      domain,
      certAltNames
    );
    console.log(info, `Created certificate with arn ${CertificateArn}`);
    summary.push({ created: "Certificate", id: CertificateArn });
    certificateArn = CertificateArn;
  }
  if (validateCert) {
    console.log(info, `Getting certificate validation options`);
    const ResourceRecordSets = await getCertValidationOptions(
      acm,
      certificateArn,
      [domain, ...(certAltNames || [])].length
    );
    console.log(info, `Creating Route53 domain validation record.`);
    await setDNSValues(r53, hostedZoneId, ResourceRecordSets, true);
    console.log(info, `Created Route53 domain validation record.`);
    ResourceRecordSets.forEach(({ Name }) =>
      summary.push({ created: "DNS CNAME", id: Name })
    );

    await waitForCertValidation(acm, certificateArn, (time) => {
      if (time === 0) {
        console.log(info, "Checking certificate status");
      } else {
        console.log(
          info,
          `Wating ${time}s for domain to be verified... This might take some time`
        );
      }
    });
    console.log(info, "Certificate is verified");
  } else {
    summary.push({ reused: "Certificate", id: certificateArn });
  }

  if (!cfDistLocation) {
    console.log(info, "Creating cloudfront access identity");
    const {
      CloudFrontOriginAccessIdentity: { Id: cfOAIId },
    } = await createOriginAccessIdentity(cf, domain);
    console.log(info, "Created cloudfront access identity:", cfOAIId);
    summary.push({ created: "CF Origin Access Id", id: cfOAIId });

    console.log(info, "Creating cloudfront distribution");
    const {
      Distribution: { Id, DomainName },
    } = await createCloudFrontDistribution(cf, {
      domain,
      altNames: certAltNames,
      isSPA,
      s3Name,
      certificateArn,
      priceClass,
      cfOAIId,
      region,
    });
    console.log(info, "Created cloudfront distribution: ", Id);
    summary.push({ created: "Cloudfront distribution", id: Id });
    cfDistLocation = DomainName;
  } else {
    summary.push({ reused: "Cloudfront distribution", id: useDistribution });
  }

  console.log(info, "Adding DNS record to distribution");
  const dnsVals = [
    {
      Name: domain,
      Type: "A",
      AliasTarget: {
        DNSName: cfDistLocation,
        EvaluateTargetHealth: false,
      },
    },
    {
      Name: domain,
      Type: "AAAA",
      AliasTarget: {
        DNSName: cfDistLocation,
        EvaluateTargetHealth: false,
      },
    },
  ];
  if (!noWww) {
    dnsVals.push({
      Name: "www." + domain,
      Type: "A",
      AliasTarget: {
        DNSName: `www.${s3Name}.s3-website.${region}.amazonaws.com`,
        EvaluateTargetHealth: false,
      },
    });
  }

  await setDNSValues(r53, hostedZoneId, dnsVals);
  console.log(info, "Added DNS record to distribution");
  summary.push({ created: "DNS A", id: domain });
  summary.push({ created: "DNS AAAA", id: domain });
  if (!noWww) {
    summary.push({ created: "DNS A", id: "www." + domain });
  }

  console.log(info, "All set up. Summary:");
  console.log(
    summary
      .map(({ created, reused, id }) => {
        if (created) {
          return `  - ${chalk.yellow("created")}: ${created} ${id}`;
        } else {
          return `  - ${chalk.green("reused")}: ${reused} ${id}`;
        }
      })
      .join("\n")
  );
};

const argv = yargs(hideBin(process.argv))
  .command("$0", "", (yargs) =>
    yargs
      .positional("domain-name", {
        description: "The domain name under which the site will be hosted.",
        type: "string",
      })
      .usage("$0 <domain-name>")
  )
  .option("s3-bucket-name", {
    description:
      "The name of the S3 bucket to be created. By default it will be the same as the domain name",
    type: "string",
  })
  .option("region", {
    type: "string",
    description: "Region to be used",
  })
  .option("single-page-app", {
    type: "boolean",
    description: "Set Cloudfront up for a single page app",
  })
  .option("certificate-alt-names", {
    type: "array",
    description: "Additional names in the SSL certificate",
  })
  .option("price-class", {
    type: "integer",
    description:
      "The chosen price class for cloudfront.\n0 is PriceClass_100 (US, MX, CA, EU, Israel)\n1 is PriceClass-200 (...PriceClass_100, Sth A, Kenya, Middle East, JP, HK, Philippines, Singapore, Sth Korea, TW, Thailand)\n2 is PriceClass_All",
  })
  .option("skip-create-s3", {
    type: "boolean",
    description: "Use an existing S3 bucket",
  })
  .option("skip-create-www-s3", {
    type: "boolean",
    description: "Use an existing S3 bucket",
  })
  .option("use-certificate", {
    type: "string",
    description: "Use an existing certificate with the specified ARN",
  })
  .option("use-distribution", {
    type: "string",
    description:
      "Use an existing cloudfront distribution with the specified Id",
  })
  .option("no-www", {
    type: "boolean",
    description: "Don't create resources for a www. subdomain",
  })

  .help()
  .alias("help", "h").argv;

const {
  _: [domain],
  region = "eu-central-1",
  "s3-bucket-name": s3Name,
  "certificate-alt-names": certAltNames,
  "single-page-app": isSPA,
  "price-class": priceClass = 0,
  "skip-create-s3": skipCreateS3,
  "skip-create-www-s3": skipCreateWwwS3,
  "use-certificate": useCertificate,
  "use-distribution": useDistribution,
  "no-www": noWww,
} = argv;

main({
  domain,
  region,
  s3Name: s3Name || domain,
  certAltNames,
  isSPA,
  priceClass,
  skipCreateS3,
  skipCreateWwwS3,
  useCertificate,
  useDistribution,
  noWww,
})
  .then(() => {
    console.log(info, "Done.");
    process.exit(0);
  })
  .catch((e) => {
    console.log(chalk.red("ERROR:"), e);
    process.exit(1);
  });

function isDefaultYes(answer) {
  return answer === "y" || answer === "Y" || answer === "";
}

function isDefaultNo(answer) {
  return answer !== "y" && answer !== "Y";
}

async function askQuestion(question, PAD_TO_COLLUM = 0) {
  stdout.write(" ".repeat(PAD_TO_COLLUM) + chalk.yellow("? ") + question + " ");

  const input = await getUserInput();

  return input;
}

async function getUserInput() {
  return new Promise((res) => {
    stdin.addListener("data", (d) => {
      res(d.toString().trim());
    });
  });
}
