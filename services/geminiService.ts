
import { GoogleGenAI, Modality } from "@google/genai";
import { Scene, StoryMetadata, SubtitleLine, VeoReferenceImage, VideoSettings } from "../types";
import { decodeBase64, pcmToWav, concatenateBuffers } from "./audioUtils";

// Initialize AI Client helper
const getAiClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) throw new Error("API Key not found");
  return new GoogleGenAI({ apiKey });
};

// --- 1. Story Generation with Search Grounding ---

export const generateStoryFromBook = async (bookName: string): Promise<{ metadata: StoryMetadata; scenes: Scene[] }> => {
  const ai = getAiClient();
  
  const prompt = `
    You are an expert children's book adapter. 
    1. Search for the children's book "${bookName}". 
    2. Summarize the plot.
    3. Create a video script with exactly 3 distinct scenes that tell the core story.
    4. For each scene, provide:
       - English narration text (very short, simple sentences suitable for young children. Max 3 sentences per scene).
       - Chinese translation of the narration.
       - A highly detailed visual description for video generation.
       - The mood of the voice (e.g., 'cheerful', 'calm', 'suspenseful').
    5. Also provide a "visualStyle" and "characterDescription" to ensure consistency across the video.
    
    Output the result as a valid, parsable JSON object matching this structure:
    {
      "metadata": {
        "title": "string",
        "summary": "string",
        "visualStyle": "string description",
        "characterDescription": "string description"
      },
      "scenes": [
        {
          "id": 1,
          "textEn": "string",
          "textZh": "string",
          "visualPrompt": "string",
          "voiceMood": "string"
        }
      ]
    }
  `;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
      // Note: responseMimeType: "application/json" is NOT supported with tools
    }
  });

  if (!response.text) throw new Error("No response from AI");
  
  // 1. Extract JSON
  let jsonStr = response.text.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(json)?/, '').replace(/```$/, '').trim();
  }
  
  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch (e) {
    console.error("JSON Parse Error", e);
    throw new Error("Failed to parse story data from AI");
  }

  // 2. Extract Search Sources (Grounding)
  const sources: string[] = [];
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (chunks) {
    chunks.forEach((chunk: any) => {
      if (chunk.web?.uri) {
        sources.push(chunk.web.uri);
      }
    });
  }

  // Transform to our internal type
  const metadata: StoryMetadata = {
    ...data.metadata,
    sources
  };

  const scenes: Scene[] = data.scenes.map((s: any) => ({
    ...s,
    status: 'pending'
  }));

  return { metadata, scenes };
};

// --- 2. Reference Image Generation (Consistency) ---

export const generateReferenceImage = async (metadata: StoryMetadata, settings: VideoSettings): Promise<string> => {
  const ai = getAiClient();
  
  // Map video settings to image settings
  // 720p -> 1K, 1080p -> 2K (Available: 1K, 2K, 4K)
  const imageSize = settings.resolution === '1080p' ? '2K' : '1K';
  
  // We use gemini-3-pro-image-preview for high quality reference
  const prompt = `Character sheet, full body shot. ${metadata.characterDescription}. Art style: ${metadata.visualStyle}. White background, consistent lighting. High quality, detailed.`;

  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-image-preview',
    contents: {
      parts: [{ text: prompt }]
    },
    config: {
      imageConfig: {
        aspectRatio: settings.aspectRatio, // Use user selected aspect ratio
        imageSize: imageSize
      }
    }
  });

  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData) {
      return `data:image/png;base64,${part.inlineData.data}`;
    }
  }
  throw new Error("Failed to generate reference image");
};

// --- 3. Video Generation (Veo) ---

export const generateVeoVideo = async (
  scene: Scene, 
  referenceImageUrl: string,
  settings: VideoSettings
): Promise<string> => {
  // Check for selected API key (Required for Veo)
  const win = window as any;
  if (win.aistudio && await win.aistudio.hasSelectedApiKey()) {
     // Key is managed by the environment injection if selected
  } else if (win.aistudio) {
      // This should ideally be handled in UI before calling, but safe guard here
      await win.aistudio.openSelectKey();
  }

  // Re-instantiate to ensure we catch the selected key if it just happened
  const ai = getAiClient();

  // Prepare Reference Image
  const base64Data = referenceImageUrl.split(',')[1];
  
  // We need to match the type expected by the SDK
  const referenceImagesPayload: any[] = [{
      image: {
          imageBytes: base64Data,
          mimeType: 'image/png',
      },
      referenceType: 'ASSET' // Treat as the character asset
  }];

  // CRITICAL: Veo 3.1 with reference images ONLY supports 720p and 16:9.
  // We must override the user settings if reference images are used to avoid API Error 400.
  const effectiveResolution = '720p'; 
  const effectiveAspectRatio = '16:9';

  let operation = await ai.models.generateVideos({
    model: 'veo-3.1-generate-preview',
    prompt: `${scene.visualPrompt}. Cinematic, high quality.`,
    config: {
      numberOfVideos: 1,
      resolution: effectiveResolution,
      aspectRatio: effectiveAspectRatio,
      referenceImages: referenceImagesPayload
    }
  });

  // Polling
  while (!operation.done) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    operation = await ai.operations.getVideosOperation({ operation: operation });
  }

  const videoUri = operation.response?.generatedVideos?.[0]?.video?.uri;
  if (!videoUri) throw new Error("Video generation failed: No URI returned");

  // Fetch the actual video blob
  const videoRes = await fetch(`${videoUri}&key=${process.env.API_KEY}`);
  const videoBlob = await videoRes.blob();
  return URL.createObjectURL(videoBlob);
};

// --- 4. TTS Generation with Timestamps ---

const generateAudioChunk = async (text: string, voiceName: string): Promise<Uint8Array> => {
  const ai = getAiClient();
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{ parts: [{ text: text }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName }
        },
      },
    },
  });

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) throw new Error("No audio data returned");
  return decodeBase64(base64Audio);
};

export const generateSceneAudio = async (
  textEn: string, 
  textZh: string, 
  mood: string
): Promise<{ url: string, duration: number, subtitles: SubtitleLine[] }> => {
  
  // Map mood to voices (simple heuristic)
  let voiceName = 'Puck'; 
  const m = mood.toLowerCase();
  if (m.includes('happy') || m.includes('excited')) voiceName = 'Kore';
  if (m.includes('calm') || m.includes('sad')) voiceName = 'Fenrir';
  if (m.includes('suspense')) voiceName = 'Charon';

  // Split text into sentences (naïve split by punctuation)
  const enSentences = textEn.match(/[^.!?]+[.!?]+/g) || [textEn];
  const zhSentences = textZh.match(/[^。！？]+[。！？]+/g) || [textZh];

  const audioChunks: Uint8Array[] = [];
  const subtitles: SubtitleLine[] = [];
  let currentOffset = 0;

  // Process sentence by sentence
  for (let i = 0; i < enSentences.length; i++) {
    const enLine = enSentences[i].trim();
    const zhLine = zhSentences[i] ? zhSentences[i].trim() : (i === enSentences.length - 1 && i < zhSentences.length ? zhSentences.slice(i).join(' ') : '');

    if (!enLine) continue;

    const pcmChunk = await generateAudioChunk(enLine, voiceName);
    audioChunks.push(pcmChunk);

    // Calculate duration: length / (sampleRate * channels * bytesPerSample)
    // SampleRate = 24000, 1 channel, 16bit (2bytes)
    const duration = pcmChunk.length / 2 / 24000;

    subtitles.push({
      textEn: enLine,
      textZh: zhLine,
      startTime: currentOffset,
      endTime: currentOffset + duration
    });

    currentOffset += duration;
  }

  // Merge all chunks
  const fullPcm = concatenateBuffers(audioChunks);
  
  // Convert to WAV
  const wavBlob = pcmToWav(fullPcm, 24000);

  return {
    url: URL.createObjectURL(wavBlob),
    duration: currentOffset,
    subtitles
  };
};
