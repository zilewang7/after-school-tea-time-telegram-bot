import { HarmCategory, HarmBlockThreshold, SafetySetting } from "@google/generative-ai";

export const safetySettings: SafetySetting[] = [
    {
      category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_HARASSMENT,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
      category: "HARM_CATEGORY_CIVIC_INTEGRITY" as HarmCategory,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    },
  ];