export enum ModelProviderTags {
  RequiresApiKey = "Requires API Key",
  RequiresSignIn = "Requires Sign-In", // LogikHub
  Local = "Local",
  Free = "Free",
  OpenSource = "Open-Source",
}

export const MODEL_PROVIDER_TAG_COLORS = {
  [ModelProviderTags.RequiresApiKey]: "#FF0000",
  [ModelProviderTags.RequiresSignIn]: "#FF8800", // Orange (LogikHub)
  [ModelProviderTags.Local]: "#00BB00",
  [ModelProviderTags.OpenSource]: "#0033FF",
  [ModelProviderTags.Free]: "#FFFF00",
};
