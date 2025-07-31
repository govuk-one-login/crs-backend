import * as builders from "@atlaskit/adf-utils/builders";
import { Match, Template } from "aws-cdk-lib/assertions";
import { readFileSync } from "fs";
import { load } from "js-yaml";
import { stringify } from "querystring";
import { schema } from "yaml-cfn";

const CONFLUENCE_BASE = "https://govukverify.atlassian.net/wiki";
const CONFLUENCE_PAGE_ID = "5537169450";
const ATLAS_USER_NAME = process.env.ATLAS_USER_NAME;
const ATLAS_API_TOKEN = process.env.ATLAS_API_TOKEN;

console.log(CONFLUENCE_BASE);
console.log(CONFLUENCE_PAGE_ID);
// console.log(ATLAS_USER_NAME);
// console.log(ATLAS_API_TOKEN);

// https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/

async function main() {
  const yamlTemplate = load(readFileSync("../backend/template.yaml", "utf-8"), {
    schema: schema,
  });

  let validAlarmDefinitions = Object.entries(yamlTemplate.Resources).filter(
    ([LogicalResourceId, Definition]) => {
      return Definition.Type == "AWS::CloudWatch::Alarm" && Definition.Metadata;
    }
  );

  console.log(JSON.stringify(validAlarmDefinitions, null, 2));

  const adfDoc = builders.doc(
    builders.heading({ level: 1 })(builders.strong("CRS Runbooks - Alarms")),
    builders.p("This page is auto generated!"),
    builders.p("2"),
    builders.hardBreak(),
    builders.heading({ level: 2 })(builders.text("Alarms")),
    builders.heading({ level: 3 })(
      builders.textColor({ color: "#16ab3e" })(validAlarmDefinitions[0][0])
    ),
    builders.codeBlock({ language: "json" })(
      builders.text(validAlarmDefinitions[0][1].Metadata.RunBook.Cause),
      builders.text(validAlarmDefinitions[0][1].Metadata.RunBook.Action)
    ),
    builders.expand({ __expanded: false, title: "Alarm Definition" })(
      builders.codeBlock({ language: "json" })(
        builders.text(JSON.stringify(validAlarmDefinitions[0][1], null, 2))
      )
    )
  );

  console.log(JSON.stringify(adfDoc, null, 2));

  let getPage = await fetch(
    "https://govukverify.atlassian.net/wiki/api/v2/pages/5537169450",
    {
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${ATLAS_USER_NAME}:${ATLAS_API_TOKEN}`
        ).toString("base64")}`,
        Accept: "application/json",
      },
    }
  );
  console.log(getPage);
  let getPageData;
  try {
    getPageData = await getPage.json();
    console.log(getPageData);
  } catch (error) {
    console.error(error.message);
  }

  const bodyData = {
    id: 5537169450,
    status: "current",
    title: "Automated Runbook Test",
    version: {
      number: getPageData.version.number + 1,
    },
    body: {
      representation: "atlas_doc_format",
      value: JSON.stringify(adfDoc),
    },
  };

  let updatePage = await fetch(
    "https://govukverify.atlassian.net/wiki/api/v2/pages/5537169450",
    {
      method: "PUT",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${ATLAS_USER_NAME}:${ATLAS_API_TOKEN}`
        ).toString("base64")}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyData),
    }
  );

  console.log(JSON.stringify(updatePage, null, 2));
  console.log(updatePage);
  try {
    let updatePageData = await updatePage.json();
    console.log(updatePageData);
  } catch (error) {
    console.error(error.message);
  }
}

await main();
