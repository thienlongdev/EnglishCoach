import sys
import yt_dlp

video_id = "s8Ad8w3vxxo"
if len(sys.argv) > 1:
    video_id = sys.argv[1]

url = f"https://www.youtube.com/watch?v={video_id}"

clients_to_test = [
    ["android"],
    ["ios"],
    ["mweb"],
    ["tv_embedded"],
    ["web"],
    ["android", "ios", "web"],
    ["android_creator", "ios", "mweb"]
]

for clients in clients_to_test:
    print(f"\n--- Testing player_client: {clients} ---")
    ydl_opts = {
        "extractor_args": {
            "youtube": {
                "player_client": clients
            }
        },
        "quiet": True,
        "no_warnings": True,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            print("SUCCESS! Title:", info.get("title"))
            print("Duration:", info.get("duration"))
            subs = list((info.get("subtitles") or {}).keys())
            auto = list((info.get("automatic_captions") or {}).keys())
            print("Subtitles count:", len(subs), "Auto captions count:", len(auto))
            if "en" in subs or "en" in auto or any("en" in k for k in auto):
                print("English caption track found!")
            break
    except Exception as e:
        print("FAILED with", type(e).__name__, str(e)[:120])
