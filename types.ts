
export interface GeneratedPhoto {
  id: string;
  url: string;
  caption: string;
  chapter: string;
  isSaved?: boolean;
}

export interface UserProfile {
  id: string;
  email: string;
  credits: number;
}

export interface StoryChapter {
  title: string;
  prompt: string;
}

export const CREDIT_COSTS = {
  GENERATE_ALBUM: 10,
  DOWNLOAD_FULL_ALBUM: 5,
  DOWNLOAD_SINGLE_PHOTO: 1
};
