
import { GoogleGenAI, Type } from "@google/genai";

// Fix: Always use process.env.API_KEY directly in initialization
const getAI = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

export const analyzePhoto = async (base64Image: string): Promise<{ description: string; location: string }> => {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: [
      {
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: base64Image.split(',')[1] } },
          { text: "Describe the person in this photo in detail (gender, age group, hair color/style, clothing) and the specific environment/location they are in. Return the answer in JSON format with two keys: 'personDescription' and 'locationName'." }
        ]
      }
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          personDescription: { type: Type.STRING },
          locationName: { type: Type.STRING }
        },
        required: ['personDescription', 'locationName']
      }
    }
  });

  const result = JSON.parse(response.text || '{}');
  return {
    description: result.personDescription || "A person",
    location: result.locationName || "An environment"
  };
};

export const generateStoryPhoto = async (
  originalBase64: string, 
  personDesc: string, 
  location: string, 
  chapterPrompt: string
): Promise<string | null> => {
  const ai = getAI();
  
  // Use gemini-2.5-flash-image for image-to-image/editing generation
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: {
      parts: [
        { 
          inlineData: { 
            mimeType: 'image/jpeg', 
            data: originalBase64.split(',')[1] 
          } 
        },
        { 
          text: `Create a new, highly realistic and cinematic photo based on this person: ${personDesc}. 
                 The location is: ${location}. 
                 Specific action for this photo: ${chapterPrompt}. 
                 Ensure the person's facial features, hair, and clothing match the original photo exactly to maintain perfect consistency. 
                 The result should look like a professional photograph from a real vacation album.`
        }
      ]
    }
  });

  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData) {
      return `data:image/png;base64,${part.inlineData.data}`;
    }
  }

  return null;
};
