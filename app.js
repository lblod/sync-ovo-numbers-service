import { app, errorHandler } from "mu";
import fetch from "node-fetch";
import { CronJob } from "cron";
import {
  getAbbOrganizationInfo,
  constructOvoStructure,
  updateOvoNumberAndUri,
  createKboOrg,
  getKboOrganizationInfo,
  updateKboOrg,
  getAllAbbKboOrganizations,
} from "./lib/queries";
import { CRON_PATTERN } from "./config";
import { API_STATUS_CODES } from "./api-error-handler";
import { getKboFields, isUpdateNeeded } from "./lib/wegwijs-api";

const WEGWIJS_SEARCH_ORGANIZATION_API =
  "https://api.wegwijs.vlaanderen.be/v1/search/organisations";
const WEGWIJS_API_FIELDS =
  "changeTime,name,shortName,ovoNumber,kboNumber,labels,contacts,organisationClassifications,locations";

app.post("/sync-kbo-data/:kboStructuredIdUuid", async (req, res) => {
  try {
    // Get the ABB organization details
    const abbOrganizationInfo = await getAbbOrganizationInfo(
      req.params.kboStructuredIdUuid
    );

    if (!abbOrganizationInfo?.kbo) {
      return setServerStatus(API_STATUS_CODES.STATUS_NO_DATA_OP, res);
    }

    // Get KBO organization details from Wegwijs API
    const kboFields = await getWegwijsOrganisation(abbOrganizationInfo.kbo);

    if (!kboFields) {
      return setServerStatus(API_STATUS_CODES.ERROR_NO_DATA_WEGWIJS, res);
    }

    await createOrUpdateKboOrg(
      abbOrganizationInfo.abbOrgUri,
      abbOrganizationInfo.kboIdUri,
      kboFields
    );

    await createOrUpdateOvoStructure(
      kboFields.ovoNumber,
      abbOrganizationInfo.ovo,
      abbOrganizationInfo.kboStructuredIdUri,
      abbOrganizationInfo.ovoStructuredIdUri
    );

    return setServerStatus(API_STATUS_CODES.OK, res);
  } catch (e) {
    return setServerStatus(API_STATUS_CODES.CUSTOM_SERVER_ERROR, res, e);
  }
});

new CronJob(
  CRON_PATTERN,
  async () => {
    const now = new Date().toISOString();
    console.log(`Wegwijs data healing triggered by cron job at ${now}`);
    try {
      await healAbbWithWegWijsData();
    } catch (err) {
      console.log(
        `An error occurred during wegwijs data healing at ${now}: ${err}`
      );
    }
  },
  null,
  true
);

/**
 * Create or update the KBO organization
 * @param {string} abbOrgUri - The ABB organization URI
 * @param {string} kboIdentifierUri - The KBO identifier URI
 * @param {import('./typedefs.js').KboFields} kboFields - The KBO fields
 */
const createOrUpdateKboOrg = async (abbOrgUri, kboIdentifierUri, kboFields) => {
  // Get KBO organization details from ABB
  const kboOrganizationInfo = await getKboOrganizationInfo(abbOrgUri);

  const isCreateNeeded = !kboOrganizationInfo && kboFields;
  if (isCreateNeeded) {
    // Create KBO organization
    await createKboOrg(kboFields, kboIdentifierUri, abbOrgUri);
  } else if (
    kboOrganizationInfo &&
    isUpdateNeeded(kboFields?.changeTime, kboOrganizationInfo.modified)
  ) {
    // Update KBO organization
    await updateKboOrg(kboFields, kboOrganizationInfo);
  }
};

/**
 * Create or update the OVO structure
 * @param {string} wegwijsOvo - The OVO number from Wegwijs
 * @param {string} abbOvo - The OVO number from ABB
 * @param {string} kboStructuredIdUri - The KBO structured ID URI
 * @param {string} ovoStructuredIdUri - The OVO structured ID URI
 */
const createOrUpdateOvoStructure = async (
  wegwijsOvo,
  abbOvo,
  kboStructuredIdUri,
  ovoStructuredIdUri
) => {
  // If a KBO can't be found in wegwijs but we already have an OVO for it in OP, we keep that OVO.
  // It happens especially a lot for worship services that sometimes lack data in Wegwijs.
  if (wegwijsOvo && wegwijsOvo != abbOvo) {
    if (!ovoStructuredIdUri) {
      ovoStructuredIdUri = await constructOvoStructure(kboStructuredIdUri);
    }
    await updateOvoNumberAndUri(ovoStructuredIdUri, wegwijsOvo);
  }
};

/**
 * Heal the ABB organizations with Wegwijs data
 */
async function healAbbWithWegWijsData() {
  try {
    console.log("Healing wegwijs info starting...");
    const allAbbKboOrganizations = await getAllAbbKboOrganizations();
    const allWegwijsOrganisations = await getAllWegwijsOrganisations();

    for (const abbOrganizationInfo of allAbbKboOrganizations) {
      const wegwijsKboFields = allWegwijsOrganisations[abbOrganizationInfo.kbo];
      if (wegwijsKboFields) {
        await createOrUpdateKboOrg(
          abbOrganizationInfo.abbOrgUri,
          abbOrganizationInfo.kboIdUri,
          wegwijsKboFields
        );

        await createOrUpdateOvoStructure(
          wegwijsKboFields.ovoNumber,
          abbOrganizationInfo.ovo,
          abbOrganizationInfo.kboStructuredIdUri,
          abbOrganizationInfo.ovoStructuredIdUri
        );
      }
    }
    console.log("Healing complete!");
  } catch (err) {
    console.log(`An error occurred during wegwijs info healing: ${err}`);
  }
}

/**
 * Get the organisation from Wegwijs
 * @param {string} kboNumber - The KBO number
 * @returns {Promise<import('./typedefs.js').KboFields>} - The KBO fields
 */
const getWegwijsOrganisation = async (kboNumber) => {
  const url = `${WEGWIJS_SEARCH_ORGANIZATION_API}?q=kboNumber:${kboNumber}&fields=${WEGWIJS_API_FIELDS}`;
  console.log("url: " + url);

  const response = await fetch(url);
  const data = await response.json();

  return data.length ? getKboFields(data[0]) : null;
};

/**
 * Get all organisations from Wegwijs
 * @typedef {{[key: string]: import('./typedefs.js').KboFields}} Organisations
 * @returns {Promise<Organisations>} - Object containing all organisations from Wegwijs indexed by KBO number
 */
const getAllWegwijsOrganisations = async () => {
  let organisations = {};

  const response = await fetch(
    `${WEGWIJS_SEARCH_ORGANIZATION_API}?q=kboNumber:/.*[0-9].*/&fields=${WEGWIJS_API_FIELDS},parents&scroll=true`
  );
  const scrollId = JSON.parse(
    response.headers.get("x-search-metadata")
  ).scrollId;
  let data = await response.json();

  do {
    data.forEach((organisation) => {
      const kboFields = getKboFields(organisation);
      organisations[kboFields.kboNumber] = kboFields;
    });

    const response = await fetch(
      `${WEGWIJS_SEARCH_ORGANIZATION_API}/scroll?id=${scrollId}`
    );
    data = await response.json();
  } while (data.length);

  return organisations;
};

function setServerStatus(statusCode, res, message) {
  if (statusCode.CODE === 500) {
    console.log("Something went wrong while calling /sync-from-kbo", message);
  }
  return res.status(statusCode.CODE).send(statusCode.STATUS);
}

app.use(errorHandler);
