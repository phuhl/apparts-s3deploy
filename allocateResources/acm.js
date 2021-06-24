const {
  ACMClient,
  RequestCertificateCommand,
  DescribeCertificateCommand,
} = require("@aws-sdk/client-acm");

const getACM = () => new ACMClient({ region: "us-east-1" });

const createCertificate = async (acm, domain, altNames) => {
  const certParams = {
    ValidationMethod: "DNS",
    DomainName: domain,
    SubjectAlternativeNames: altNames,
  };
  return await acm.send(new RequestCertificateCommand(certParams));
};

const isCertificateValidated = async (acm, arn) => {
  const {
    Certificate: { Status },
  } = await acm.send(
    new DescribeCertificateCommand({
      CertificateArn: arn,
    })
  );

  return Status === "ISSUED";
};

const getCertValidationOptions = async (acm, arn, domainCount) => {
  let trys = 0;
  do {
    trys++;
    const {
      Certificate: { DomainValidationOptions = [] } = {},
    } = await acm.send(
      new DescribeCertificateCommand({
        CertificateArn: arn,
      })
    );
    if (
      DomainValidationOptions.length === domainCount &&
      DomainValidationOptions[0].ResourceRecord &&
      DomainValidationOptions[0].ResourceRecord.Name &&
      DomainValidationOptions[0].ResourceRecord.Value &&
      DomainValidationOptions[0].ResourceRecord.Type
    ) {
      return DomainValidationOptions.map(
        ({ ResourceRecord: { Name, Type, Value } }) => ({
          Name,
          Type,
          ResourceRecords: [
            {
              Value,
            },
          ],
        })
      );
    }
    await new Promise((res) => setTimeout(() => res(), 2000 * trys));
  } while (trys <= 3);
  throw new Error(
    "Could not retrieve domain validation options. Maybe try later again."
  );
};

const waitForCertValidation = async (acm, arn, statusUpdates = () => {}) => {
  let verified = false;
  let counter = 0;
  do {
    counter += 10;
    statusUpdates(counter);
    await new Promise((res) => setTimeout(() => res(), 1000 * counter));
    statusUpdates(0);
    const {
      Certificate: { Status },
    } = await acm.send(
      new DescribeCertificateCommand({
        CertificateArn: arn,
      })
    );
    if (Status !== "PENDING_VALIDATION") {
      if (Status === "ISSUED") {
        verified = true;
      } else {
        throw new Error("Certificate could not be issued: " + Status);
      }
    }
  } while (!verified);
};

module.exports = {
  getACM,
  createCertificate,
  getCertValidationOptions,
  waitForCertValidation,
  isCertificateValidated,
};
