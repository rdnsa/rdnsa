import { readFile, writeFile } from "node:fs/promises";

const username =
  process.env.GITHUB_USERNAME || process.env.GITHUB_REPOSITORY_OWNER || "rdnsa";
const token =
  process.env.CONTRIBUTION_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const readmePath = process.env.README_PATH || "README.md";

const startMarker = "<!-- CONTRIBUTION-STATS:START -->";
const endMarker = "<!-- CONTRIBUTION-STATS:END -->";

if (!token) {
  throw new Error(
    "Set GITHUB_TOKEN or CONTRIBUTION_TOKEN to update the contribution log."
  );
}

const query = `
  query ContributionCalendar($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }
`;

const response = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "rdnsa-profile-readme",
  },
  body: JSON.stringify({ query, variables: { login: username } }),
});

if (!response.ok) {
  const body = await response.text();
  throw new Error(`GitHub GraphQL request failed: ${response.status} ${body}`);
}

const payload = await response.json();

if (payload.errors?.length) {
  throw new Error(payload.errors.map((error) => error.message).join("; "));
}

const calendar =
  payload.data?.user?.contributionsCollection?.contributionCalendar;

if (!calendar) {
  throw new Error(`No GitHub contribution calendar found for ${username}.`);
}

const allDays = calendar.weeks
  .flatMap((week) => week.contributionDays)
  .sort((a, b) => a.date.localeCompare(b.date));

const activeDays = allDays.filter((day) => day.contributionCount > 0);
const periodStart = allDays[0]?.date ?? "-";
const periodEnd = allDays.at(-1)?.date ?? "-";

const dateFormatter = new Intl.DateTimeFormat("id-ID", {
  day: "2-digit",
  month: "long",
  year: "numeric",
  timeZone: "Asia/Jakarta",
});

const monthFormatter = new Intl.DateTimeFormat("id-ID", {
  month: "long",
  year: "numeric",
  timeZone: "Asia/Jakarta",
});

const numberFormatter = new Intl.NumberFormat("id-ID");

function toDate(value) {
  return new Date(`${value}T00:00:00Z`);
}

function formatDate(value) {
  return dateFormatter.format(toDate(value));
}

function formatMonth(value) {
  return monthFormatter.format(toDate(`${value}-01`));
}

const monthlyTotals = new Map();

for (const day of allDays) {
  const month = day.date.slice(0, 7);
  const current = monthlyTotals.get(month) ?? { activeDays: 0, total: 0 };
  current.total += day.contributionCount;
  if (day.contributionCount > 0) current.activeDays += 1;
  monthlyTotals.set(month, current);
}

const monthlyRows = [...monthlyTotals.entries()]
  .filter(([, month]) => month.total > 0)
  .sort(([a], [b]) => b.localeCompare(a))
  .map(
    ([month, value]) =>
      `| ${formatMonth(month)} | ${numberFormatter.format(
        value.activeDays
      )} | ${numberFormatter.format(value.total)} |`
  );

const dailyRows = activeDays
  .toReversed()
  .map(
    (day) =>
      `| ${formatDate(day.date)} | ${formatMonth(day.date.slice(0, 7))} | ${numberFormatter.format(
        day.contributionCount
      )} |`
  );

const generated = [
  startMarker,
  `Data otomatis dari GitHub contribution calendar untuk akun \`${username}\`.`,
  "",
  `- **Periode:** \`${periodStart}\` sampai \`${periodEnd}\``,
  `- **Total contribution:** \`${numberFormatter.format(
    calendar.totalContributions
  )}\``,
  `- **Hari aktif:** \`${numberFormatter.format(activeDays.length)}\``,
  "",
  "| Bulan | Hari aktif | Contribution |",
  "| --- | ---: | ---: |",
  ...(monthlyRows.length ? monthlyRows : ["| - | 0 | 0 |"]),
  "",
  "<details>",
  "<summary>Contribution per hari</summary>",
  "",
  "| Tanggal | Bulan | Contribution |",
  "| --- | --- | ---: |",
  ...(dailyRows.length ? dailyRows : ["| - | - | 0 |"]),
  "",
  "</details>",
  endMarker,
].join("\n");

const readme = await readFile(readmePath, "utf8");
let nextReadme;

if (readme.includes(startMarker) && readme.includes(endMarker)) {
  nextReadme = readme.replace(
    new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`),
    generated
  );
} else {
  nextReadme = readme.replace("</picture>", `</picture>\n\n${generated}`);
}

if (nextReadme !== readme) {
  await writeFile(readmePath, nextReadme, "utf8");
}
