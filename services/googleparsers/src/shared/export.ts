import type { NewsResult, PlaceResult } from "./types";

const MAPS_CSV_COLUMNS = [
  "title",
  "placeUrl",
  "website",
  "status",
  "email",
  "rating",
  "reviewCount",
  "category",
  "address",
  "linkedInUrl",
  "phoneNumber",
  "searchQuery"
];

const NEWS_CSV_COLUMNS = ["query", "position", "title", "body", "posted", "source", "link"];

export function toCsv(results: PlaceResult[]): string {
  const header = MAPS_CSV_COLUMNS.join(",");
  const rows = results.map((result) => MAPS_CSV_COLUMNS.map((column) => escapeCsv(csvValue(result, column))).join(","));
  return [header, ...rows].join("\r\n");
}

export function newsToCsv(results: NewsResult[]): string {
  const header = NEWS_CSV_COLUMNS.join(",");
  const rows = results.map((result) => NEWS_CSV_COLUMNS.map((column) => escapeCsv(newsCsvValue(result, column))).join(","));
  return [header, ...rows].join("\r\n");
}

function csvValue(result: PlaceResult, column: string): string {
  const linkedInUrl = result.linkedInUrl || result.socials.find((social) => social.toLowerCase().includes("linkedin.com")) || "";

  switch (column) {
    case "title":
      return result.name;
    case "placeUrl":
      return result.googleMapsUrl;
    case "website":
      return result.website;
    case "status":
      return result.emails.length > 0 || linkedInUrl ? "Data found" : "No data found";
    case "email":
      return result.emails.join("; ");
    case "rating":
      return result.rating;
    case "reviewCount":
      return result.reviewsCount;
    case "category":
      return result.category;
    case "address":
      return result.address;
    case "linkedInUrl":
      return linkedInUrl;
    case "phoneNumber":
      return result.phone;
    case "searchQuery":
      return result.sourceUrl;
    default:
      return "";
  }
}

function newsCsvValue(result: NewsResult, column: string): string {
  switch (column) {
    case "query":
      return result.query;
    case "position":
      return String(result.position);
    case "title":
      return result.title;
    case "body":
      return result.body;
    case "posted":
      return result.posted;
    case "source":
      return result.source;
    case "link":
      return result.link;
    default:
      return "";
  }
}

function escapeCsv(value: string): string {
  if (!/[",\r\n;]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
