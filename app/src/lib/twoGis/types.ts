export const TWO_GIS_SOURCE_COLUMNS = [
  'id',
  'name',
  'city_name',
  'geometry_name',
  'post_code',
  'phone',
  'email',
  'website',
  'vkontakte',
  'instagram',
  'lon',
  'lat',
  'category',
  'subcategory',
] as const;

export type TwoGisSourceColumn = (typeof TWO_GIS_SOURCE_COLUMNS)[number];

export type TwoGisCard = Record<TwoGisSourceColumn, string>;

export interface TwoGisFilters {
  cities?: string[];
  categories?: string[];
  subcategories?: string[];
  name?: string;
  hasPhone?: boolean;
  hasEmail?: boolean;
  hasWebsite?: boolean;
  hasVkontakte?: boolean;
  hasInstagram?: boolean;
}

export interface TwoGisQuery {
  text: string;
  params: unknown[];
}

export interface TwoGisFacet {
  value: string;
  count: number;
}

export interface TwoGisSubcategoryFacet extends TwoGisFacet {
  category: string;
}

export interface TwoGisFacets {
  cities: TwoGisFacet[];
  categories: TwoGisFacet[];
  subcategories: TwoGisSubcategoryFacet[];
  snapshot: {
    scope: string;
    date: string;
    rows: number;
  };
}
