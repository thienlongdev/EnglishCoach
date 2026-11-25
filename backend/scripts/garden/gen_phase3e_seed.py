"""Echo Garden Phase 3E — catalogue source and one-time generator of the V86 seed.

    python backend/scripts/garden/gen_phase3e_seed.py

Writes (from the tables below, the single reviewed source of the Phase 3E catalogue):
  * backend/src/test/resources/garden/phase3e_catalogue.json   (read by the backend tests and the frontend asset audit)
  * backend/src/main/resources/db/migration/exams/V86__echo_garden_phase3e_cosmetics.sql  (schema template + seed rows)

V86 is immutable once it has been applied anywhere: after that this script is history, and any catalogue change ships
as a NEW migration. Prices are Đồng Echo (the Garden coin); no real-money price exists in this file.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.abspath(os.path.join(HERE, "..", ".."))
JSON_OUT = os.path.join(BACKEND, "src", "test", "resources", "garden", "phase3e_catalogue.json")
SQL_OUT = os.path.join(BACKEND, "src", "main", "resources", "db", "migration", "exams", "V86__echo_garden_phase3e_cosmetics.sql")

COLLECTIONS = [
    ("BLOSSOM", "Xuân Hoa Khai", "Anh đào, đào phai và những cánh hoa đầu mùa."),
    ("SUNGOLD", "Hạ Nắng Vàng", "Hướng dương, nắng mật và hiên nhà rợp bóng."),
    ("AMBER", "Thu Hổ Phách", "Lá phong, bí ngô và mùa gặt vàng óng."),
    ("FROST", "Đông Pha Lê", "Băng tinh, tuyết đầu mùa và ánh đèn ấm."),
    ("TET", "Tết Nguyên Đán", "Mai vàng, đào thắm, bao lì xì và cây nêu ngày Tết."),
    ("TRUNGTHU", "Trung Thu Trăng Rằm", "Đèn ông sao, đèn lồng và thỏ ngọc dưới trăng."),
    ("LONGPHUNG", "Long Phụng Thiên Cung", "Rồng vàng, phượng lửa và mái ngói ngọc cong vút."),
    ("CELESTIAL", "Tinh Nguyệt", "Trăng, sao, cực quang và cầu vồng."),
    ("LEHOI", "Lễ Hội Bốn Phương", "Đêm bí ngô, Giáng Sinh và hội mùa khắp nơi."),
    ("NGOC", "Ngọc và San Hô", "Ngọc bích, đá quý, san hô và vườn thượng uyển."),
]

# crop skins: (art, crop, collection, name, description, unlock, coin price, mastery tier, learning days)
C, MA, LE = "COIN", "MASTERY", "LEARNING"
SKINS = [
    ("wheat_blossom", "WHEAT", "BLOSSOM", "Lúa Hoa Anh Đào", "Bông lúa phớt hồng giữa hai cành anh đào cắm đầu luống, cánh hoa rụng kín đất.", C, 6000, 1, 0),
    ("wheat_lantern", "WHEAT", "TRUNGTHU", "Lúa Đèn Lồng", "Ruộng lúa vàng treo ba chiếc đèn lồng lụa trên cọc tre và một dây hạt sáng.", C, 9000, 1, 0),
    ("wheat_frost", "WHEAT", "FROST", "Lúa Sương Pha Lê", "Thân lúa bạc xanh, bông đọng tinh thể băng, tuyết phủ chân luống.", C, 12000, 1, 0),
    ("wheat_sunfire", "WHEAT", "LONGPHUNG", "Lúa Lông Phụng", "Bông lúa dài như lông đuôi phượng, đỏ dần sang vàng, sau luống xòe quạt lông vũ.", MA, 0, 3, 0),
    ("wheat_starlight", "WHEAT", "CELESTIAL", "Lúa Tinh Tú", "Thân lúa chàm tím, bông trắng ngà đính sao, có trăng khuyết canh luống.", LE, 0, 1, 7),
    ("tomato_peach", "TOMATO", "TET", "Cà Chua Đào Tiên", "Quả hình tim màu đào chín, hoa đào nở trên đầu cọc, cánh hoa rơi quanh gốc.", C, 8000, 1, 0),
    ("tomato_sunburst", "TOMATO", "SUNGOLD", "Cà Chua Nắng Hạ", "Quả lớn vằn vàng đỏ như tia nắng, cọc sau đội hoa hướng dương.", C, 11000, 1, 0),
    ("tomato_ice", "TOMATO", "FROST", "Cà Chua Băng Châu", "Chùm cà chua bi trong như băng, cọc phủ tuyết treo nhũ băng.", C, 16000, 1, 0),
    ("tomato_lantern", "TOMATO", "LEHOI", "Cà Chua Đèn Ma", "Quả múi như bí ngô tí hon khắc mặt cười, tán lá tím đêm.", MA, 0, 3, 0),
    ("tomato_dragon", "TOMATO", "LONGPHUNG", "Cà Chua Long Châu", "Quả thuôn dài đỏ son chót vàng, cọc sơn son đai vàng có rồng vàng quấn quanh.", LE, 0, 1, 14),
    ("corn_tet", "CORN", "TET", "Bắp Lộc Xuân", "Bẹ đỏ, hạt vàng, thân buộc nơ đỏ và treo bao lì xì, mai vàng nở dưới gốc.", C, 12000, 1, 0),
    ("corn_sun", "CORN", "SUNGOLD", "Bắp Hướng Dương", "Mỗi thân bắp đội một đóa hướng dương, trái to vàng rực.", C, 15000, 1, 0),
    ("corn_frost", "CORN", "FROST", "Bắp Tuyết Ngọc", "Hạt trắng điểm xanh, bẹ lam nhạt, tuyết đọng trên cờ và trái.", C, 22000, 1, 0),
    ("corn_amber", "CORN", "AMBER", "Bắp Mùa Gặt", "Bắp nếp nhiều màu nâu đỏ, bẹ khô bung như sao, có bó rơm và lá phong.", MA, 0, 3, 0),
    ("corn_phoenix", "CORN", "LONGPHUNG", "Bắp Hỏa Phụng", "Cờ bắp hóa thành chùm lông lửa, hạt hồng than, lá ngả sắc cam.", LE, 0, 1, 30),
    ("strawberry_blossom", "STRAWBERRY", "BLOSSOM", "Dâu Anh Đào", "Dâu hồng phấn điểm hạt trắng, hoa anh đào nở dày, cánh hoa trải kín luống.", C, 18000, 1, 0),
    ("strawberry_honey", "STRAWBERRY", "SUNGOLD", "Dâu Mật Ong", "Dâu vàng hổ phách bóng mật, góc luống có tổ ong rơm và đàn ong nhỏ.", C, 22000, 1, 0),
    ("strawberry_frost", "STRAWBERRY", "FROST", "Dâu Băng Tinh", "Quả dâu trong như pha lê trên lớp sương muối, cụm băng mọc ở góc luống.", C, 30000, 1, 0),
    ("strawberry_coral", "STRAWBERRY", "NGOC", "Dâu San Hô", "Dâu thuôn màu san hô giữa nhánh san hô, vỏ sò và ngọc trai trên nền cát.", MA, 0, 3, 0),
    ("strawberry_moon", "STRAWBERRY", "CELESTIAL", "Dâu Nguyệt Quang", "Dâu trắng tím tỏa sáng khi đêm xuống, dưới một vầng trăng khuyết và ba ngôi sao.", LE, 0, 1, 21),
    ("rose_peach", "ROSE", "TET", "Hồng Đào Xuân", "Hồng kép màu đào, cọc tre thắt nơ đỏ tua vàng, cánh hoa rơi quanh gốc.", C, 26000, 1, 0),
    ("rose_sun", "ROSE", "SUNGOLD", "Hồng Vàng Nắng", "Hồng vàng leo kín một cổng vòm trắng bắc ngang luống.", C, 34000, 1, 0),
    ("rose_frost", "ROSE", "FROST", "Hồng Băng", "Cánh hồng trong suốt như băng quanh một cụm pha lê, tỏa sáng dịu ban đêm.", C, 45000, 1, 0),
    ("rose_amber", "ROSE", "AMBER", "Hồng Hổ Phách", "Hồng màu đồng trong vành giỏ mây, lá ngả nâu đỏ, quả tầm xuân chín mọng.", MA, 0, 3, 0),
    ("rose_phoenix", "ROSE", "LONGPHUNG", "Hồng Phượng Hoàng", "Đóa hồng rực lửa với cánh vươn như lông vũ, sau luống xòe quạt lông phượng.", LE, 0, 1, 45),
    ("watermelon_tet", "WATERMELON", "TET", "Dưa Hấu Tết", "Dưa tròn xanh thẫm dán nhãn đỏ dấu vàng và thắt nơ, cành mai nở bên luống.", C, 36000, 1, 0),
    ("watermelon_sun", "WATERMELON", "SUNGOLD", "Dưa Hoàng Kim", "Dưa vỏ vàng sọc nắng nằm trên vòng lá tỏa tia, có hướng dương đứng gác.", C, 44000, 1, 0),
    ("watermelon_frost", "WATERMELON", "FROST", "Dưa Tuyết Cầu", "Dưa tròn trắng bạc hà đội mũ tuyết giữa những cụm băng.", C, 60000, 1, 0),
    ("watermelon_moon", "WATERMELON", "CELESTIAL", "Dưa Trăng Sao", "Vỏ dưa xanh đêm lấm tấm sao vàng với một vầng trăng, sao nhỏ lơ lửng trên luống.", MA, 0, 3, 0),
    ("watermelon_dragon", "WATERMELON", "LONGPHUNG", "Dưa Long Lân", "Dưa dài vảy ngọc có sừng và râu vàng, cọc son đội mây vàng.", LE, 0, 1, 60),
    ("pumpkin_rose", "PUMPKIN", "BLOSSOM", "Bí Hồng Sứ", "Bí dẹt nhiều múi màu hồng sứ, quanh cuống kết vòng hoa.", C, 48000, 1, 0),
    ("pumpkin_turban", "PUMPKIN", "AMBER", "Bí Khăn Xếp", "Bí đội mũ sọc xanh kem cam, bên bó rơm và lá phong rụng.", C, 56000, 1, 0),
    ("pumpkin_frost", "PUMPKIN", "FROST", "Bí Bạch Tuyết", "Bí trắng muốt phủ tuyết, lá viền sương, góc luống mọc băng tinh.", C, 80000, 1, 0),
    ("pumpkin_lantern", "PUMPKIN", "LEHOI", "Bí Đèn Lồng Ma", "Bí cam khắc mặt cười sáng đèn khi đêm xuống, có đèn bí treo đầu cọc.", MA, 0, 3, 0),
    ("pumpkin_moon", "PUMPKIN", "TRUNGTHU", "Bí Trăng Rằm", "Bí tròn vàng nhạt khắc trăng khuyết, đèn ông sao treo trên cọc tre.", LE, 0, 1, 75),
    ("moonflower_dawn", "MOONFLOWER", "SUNGOLD", "Hoa Trăng Bình Minh", "Loa hoa màu đào ngả vàng trên cọc trúc vàng, có mặt trời nhỏ tỏa tia.", C, 75000, 1, 0),
    ("moonflower_frost", "MOONFLOWER", "FROST", "Hoa Trăng Sương Giá", "Hoa trong như băng, mỗi cọc treo một bông tuyết sáu cánh.", C, 95000, 1, 0),
    ("moonflower_lotus", "MOONFLOWER", "TET", "Hoa Trăng Sen Hồng", "Hoa nở thành đài sen nhiều lớp cánh trên giàn tre, lá sen tròn nằm dưới gốc.", C, 120000, 1, 0),
    ("moonflower_blood", "MOONFLOWER", "LEHOI", "Hoa Trăng Huyết Nguyệt", "Hoa đỏ thẫm trên tán lá tím than, dưới một vầng trăng đỏ.", MA, 0, 3, 0),
    ("moonflower_aurora", "MOONFLOWER", "CELESTIAL", "Hoa Trăng Cực Quang", "Hoa đổi sắc lam lục tím, hai dải cực quang uốn lượn trên giàn.", LE, 0, 1, 90),
    ("frost_lily_blush", "FROST_LILY", "BLOSSOM", "Huệ Xuân Phấn", "Huệ trắng phớt hồng, lá xanh non, có bướm ghé và cành anh đào bên luống.", C, 90000, 1, 0),
    ("frost_lily_jade", "FROST_LILY", "NGOC", "Huệ Ngọc Bích", "Cánh huệ như ngọc tạc, bên một vòng ngọc bích và những viên cuội ngọc.", C, 120000, 1, 0),
    ("frost_lily_gold", "FROST_LILY", "NGOC", "Huệ Hoàng Kim", "Huệ kèn vàng với nhị dài, đứng trong một vòng đai vàng.", C, 150000, 1, 0),
    ("frost_lily_flame", "FROST_LILY", "LONGPHUNG", "Huệ Hỏa Diệm", "Huệ cam lốm đốm, cánh cuộn ngược như ngọn lửa, có lông vũ lửa sau luống.", MA, 0, 3, 0),
    ("frost_lily_aurora", "FROST_LILY", "CELESTIAL", "Huệ Cực Quang", "Huệ đổi sắc cực quang, mỗi đóa nâng một ngôi sao, thạch anh tím mọc bên cạnh.", LE, 0, 1, 120),
    ("crystal_orchid_ruby", "CRYSTAL_ORCHID", "NGOC", "Lan Hồng Ngọc", "Mỗi đóa là một viên hồng ngọc mài giác trong đài vàng.", C, 160000, 1, 0),
    ("crystal_orchid_amber", "CRYSTAL_ORCHID", "AMBER", "Lan Hổ Phách", "Những giọt hổ phách treo trên sợi vàng dọc cành lan.", C, 190000, 1, 0),
    ("crystal_orchid_emerald", "CRYSTAL_ORCHID", "NGOC", "Lan Lục Bảo", "Lan mọc từ những hốc tinh thể lục bảo tách đôi.", C, 220000, 1, 0),
    ("crystal_orchid_rainbow", "CRYSTAL_ORCHID", "CELESTIAL", "Lan Cầu Vồng", "Mỗi đóa một sắc đá quý, sau luống bắc một cầu vồng.", MA, 0, 3, 0),
    ("crystal_orchid_dragon", "CRYSTAL_ORCHID", "LONGPHUNG", "Lan Kim Long", "Lan vàng nở quanh một trụ son có rồng vàng ngậm ngọc quấn lên.", LE, 0, 1, 180),
]

# cosmetics: (code, category, family, collection, art, name, description, unlock, price, requirement, max owned, footprint)
ACH_L, ACH_H, ACH_G = "LEARNING", "HARVESTS", "GRADUATIONS"
COSMETICS = [
    ("HOUSE_BLOSSOM", "HOUSE", "HOUSE", "BLOSSOM", "blossom", "Nhà Hoa Anh Đào", "Tường hồng phấn, mái ngói hồng, tử đằng rủ quanh hiên và một cây anh đào bên đầu hồi.", C, 60000, 0, 1, 0),
    ("HOUSE_SUNGOLD", "HOUSE", "HOUSE", "SUNGOLD", "sungold", "Trang Viên Nắng Hạ", "Tường đá mật ong, mái ngói đất nung, cửa chớp xanh ngọc, hướng dương và hoa giấy quanh nhà.", C, 90000, 0, 1, 0),
    ("HOUSE_AMBER", "HOUSE", "HOUSE", "AMBER", "amber", "Nhà Mùa Gặt", "Nhà kho đỏ mái hai dốc, viền kem, có rơm, bí ngô, bó ngô và chong chóng gà trống.", C, 120000, 0, 1, 0),
    ("HOUSE_FROST", "HOUSE", "HOUSE", "FROST", "frost", "Dinh Pha Lê Mùa Đông", "Tường đá lam, mái dốc phủ tuyết treo nhũ băng, vòng nguyệt quế trên cửa, đỉnh mái đội pha lê.", C, 180000, 0, 1, 0),
    ("HOUSE_LONGPHUNG", "HOUSE", "HOUSE", "LONGPHUNG", "longphung", "Biệt Phủ Long Phụng", "Cột son, mái ngói ngọc cong vút, cửa nguyệt, đèn lồng đỏ; đôi rồng chầu ngọc trên nóc và phượng đậu cổng.", C, 320000, 0, 1, 0),
    ("TREE_SAKURA", "TREE", "TREE", "BLOSSOM", "sakura", "Anh Đào Rủ", "Tán anh đào hồng với những chuỗi hoa rủ dài quanh thân.", C, 30000, 0, 1, 0),
    ("TREE_MAPLE", "TREE", "TREE", "AMBER", "maple", "Phong Lửa", "Cây phong tán rộng đỏ rực, lá rụng dưới gốc.", C, 36000, 0, 1, 0),
    ("TREE_MAI", "TREE", "TREE", "TET", "mai", "Mai Vàng Ngày Tết", "Cành mai gân guốc nở kín hoa vàng, treo bao lì xì đỏ.", C, 45000, 0, 1, 0),
    ("TREE_CRYSTAL", "TREE", "TREE", "FROST", "crystal", "Cây Băng Tinh", "Cây mùa đông thân phủ sương, lá là những tinh thể băng, cành treo nhũ băng và sao.", C, 70000, 0, 1, 0),
    ("TREE_PHUONG", "TREE", "TREE", "SUNGOLD", "phuong", "Phượng Vĩ", "Cây phượng tán dù phủ hoa đỏ - loài hoa của mùa học.", ACH_L, 0, 30, 1, 0),
    ("SHRUB_LAVENDER", "SHRUB", "SHRUB", "BLOSSOM", "lavender", "Bụi Oải Hương", "Bụi lá bạc với những bông oải hương tím vươn cao.", C, 12000, 0, 1, 0),
    ("SHRUB_HYDRANGEA", "SHRUB", "SHRUB", "SUNGOLD", "hydrangea", "Cẩm Tú Cầu", "Bụi cẩm tú cầu nở những quả cầu hoa lam và hồng.", C, 16000, 0, 1, 0),
    ("SHRUB_TOPIARY", "SHRUB", "SHRUB", "NGOC", "topiary", "Cây Cảnh Xén Tròn", "Những quả cầu lá xén gọn trên thân thẳng, trồng trong chậu gỗ.", C, 22000, 0, 1, 0),
    ("SHRUB_BAMBOO", "SHRUB", "SHRUB", "TET", "bamboo", "Khóm Trúc", "Khóm trúc xanh xen trúc vàng, lá thon dài.", C, 28000, 0, 1, 0),
    ("SHRUB_HOLLY", "SHRUB", "SHRUB", "LEHOI", "holly", "Bụi Nhựa Ruồi Tuyết", "Bụi lá xanh thẫm đầy quả đỏ, tuyết đọng trên ngọn.", ACH_H, 0, 300, 1, 0),
    ("FLOWER_TULIP", "FLOWER", "FLOWER", "BLOSSOM", "tulip", "Luống Tulip", "Luống tulip năm màu.", C, 10000, 0, 1, 0),
    ("FLOWER_SUNFLOWER", "FLOWER", "FLOWER", "SUNGOLD", "sunflower", "Khóm Hướng Dương", "Khóm hướng dương cao thấp quay về phía người xem.", C, 14000, 0, 1, 0),
    ("FLOWER_CUC", "FLOWER", "FLOWER", "TET", "cuc", "Chậu Cúc Vàng", "Những chậu cúc vàng tròn đầy trong chậu men.", C, 20000, 0, 1, 0),
    ("FLOWER_LOTUS", "FLOWER", "FLOWER", "TET", "lotus", "Chậu Sen", "Chậu men lam nuôi sen hồng với lá và nụ.", C, 32000, 0, 1, 0),
    ("FLOWER_MOONLILY", "FLOWER", "FLOWER", "CELESTIAL", "moonlily", "Hoa Chuông Trăng", "Những chuông hoa nhạt sáng trong đêm bên vòng nấm phát quang.", ACH_G, 0, 1, 1, 0),
    ("MONUMENT_BLOSSOM", "MONUMENT", "MONUMENT", "BLOSSOM", "blossom", "Ký Ức Hoa Xuân", "Vòng trụ kết tràng hoa quanh gốc Cây Tri Thức, cầu hoa và vòng hoa treo dưới tán.", C, 60000, 0, 1, 0),
    ("MONUMENT_LANTERN", "MONUMENT", "MONUMENT", "TRUNGTHU", "lantern", "Thiên Đăng", "Đèn giấy và đèn ông sao quanh gốc, đèn lồng lụa và đèn sen treo dưới tán.", C, 90000, 0, 1, 0),
    ("MONUMENT_FROST", "MONUMENT", "MONUMENT", "FROST", "frost", "Pha Lê Mùa Đông", "Những cụm băng tinh và bông tuyết quanh gốc, đèn chùm pha lê treo dưới tán.", C, 120000, 0, 1, 0),
    ("MONUMENT_PHOENIX", "MONUMENT", "MONUMENT", "LONGPHUNG", "phoenix", "Phượng Hoàng Rạng Rỡ", "Phượng hoàng đậu trên đá bên những lò than hồng, chuỗi lông vũ treo dưới tán.", ACH_L, 0, 45, 1, 0),
    ("MONUMENT_DRAGON", "MONUMENT", "MONUMENT", "LONGPHUNG", "dragon", "Kim Long Hộ Thụ", "Đôi rồng vàng chầu ngọc trước gốc cây, mây vàng và chuỗi tiền cổ treo dưới tán.", C, 240000, 0, 1, 0),
    ("FENCE_BAMBOO", "FENCE", "FENCE", "TET", "bamboo", "Hàng Rào Tre", "Rào tre đan chéo buộc lạt, cổng tre treo đèn.", C, 14000, 0, 1, 0),
    ("FENCE_BLOSSOM", "FENCE", "FENCE", "BLOSSOM", "blossom", "Hàng Rào Trắng Hoa Leo", "Rào cọc trắng có hoa leo, cổng vòm kết hoa.", C, 18000, 0, 1, 0),
    ("FENCE_HARVEST", "FENCE", "FENCE", "AMBER", "harvest", "Hàng Rào Mùa Gặt", "Rào gỗ thô với bó lúa và bí ngô ở chân cột, cổng treo vòng lá phong.", C, 24000, 0, 1, 0),
    ("FENCE_FROST", "FENCE", "FENCE", "FROST", "frost", "Hàng Rào Sương Giá", "Rào gỗ phủ tuyết treo nhũ băng, đầu cột gắn pha lê.", C, 40000, 0, 1, 0),
    ("FENCE_LONGPHUNG", "FENCE", "FENCE", "LONGPHUNG", "longphung", "Lan Can Sơn Son", "Lan can son đỏ nan ngọc bích nạm đinh vàng, cổng tam quan mái ngọc.", C, 90000, 0, 1, 0),
    ("PATH_COBBLE", "PATH", "PATH", "AMBER", "cobble", "Lối Đá Cuội", "Những phiến đá ấm màu lát dọc lối đi, rêu mọc giữa kẽ.", C, 3000, 0, 1, 0),
    ("PATH_PETAL", "PATH", "PATH", "BLOSSOM", "petal", "Lối Cánh Hoa", "Đá trắng và đá hồng rắc cánh anh đào.", C, 9000, 0, 1, 0),
    ("PATH_BRICK", "PATH", "PATH", "AMBER", "brick", "Lối Gạch Xương Cá", "Gạch đỏ lát xương cá điểm lá phong.", C, 12000, 0, 1, 0),
    ("PATH_ICE", "PATH", "PATH", "FROST", "ice", "Lối Băng", "Những phiến băng lục giác sáng dịu trong đêm.", C, 26000, 0, 1, 0),
    ("PATH_JADE", "PATH", "PATH", "LONGPHUNG", "jade", "Lối Ngọc Bích", "Những đĩa ngọc bích khảm vòng vàng.", C, 60000, 0, 1, 0),
    ("BED_BAMBOO", "BED", "BED", "TET", "bamboo", "Luống Tre", "Khung luống ghép ống tre, cột tre buộc lạt.", C, 8000, 0, 1, 0),
    ("BED_STONE", "BED", "BED", "AMBER", "stone", "Luống Đá Rêu", "Khung luống xếp đá rêu, nẹp đá sa thạch.", C, 12000, 0, 1, 0),
    ("BED_BLOSSOM", "BED", "BED", "BLOSSOM", "blossom", "Luống Trắng Hoa Góc", "Khung luống sơn trắng, mỗi góc một chùm hoa.", C, 16000, 0, 1, 0),
    ("BED_FROST", "BED", "BED", "FROST", "frost", "Luống Sương Giá", "Khung gỗ phủ sương, nẹp tuyết, góc gắn pha lê.", C, 36000, 0, 1, 0),
    ("BED_LONGPHUNG", "BED", "BED", "LONGPHUNG", "longphung", "Luống Sơn Son Thếp Vàng", "Khung son đỏ nẹp vàng, khảm ngọc tròn.", C, 80000, 0, 1, 0),
    ("DECOR_LANTERN_STONE", "DECOR", "LANTERN", "TRUNGTHU", "lantern_stone", "Đèn Đá", "Cây đèn đá rêu phong thắp ánh nến ấm.", C, 2500, 0, 4, 0.35),
    ("DECOR_LANTERN_HOIAN", "DECOR", "LANTERN", "TET", "lantern_hoian", "Đèn Lồng Phố Hội", "Sào tre treo ba chiếc đèn lồng lụa đỏ, vàng, ngọc.", C, 6000, 0, 4, 0.35),
    ("DECOR_LANTERN_STAR", "DECOR", "LANTERN", "TRUNGTHU", "lantern_star", "Đèn Ông Sao", "Đèn ông sao lớn trên giá tre cùng hai đèn lồng nhỏ.", C, 8000, 0, 3, 0.4),
    ("DECOR_LANTERN_MOONSTONE", "DECOR", "LANTERN", "FROST", "lantern_moonstone", "Đèn Nguyệt Thạch", "Trụ băng nâng một viên nguyệt thạch tỏa sáng.", C, 18000, 0, 3, 0.35),
    ("DECOR_LANTERN_DRAGON", "DECOR", "LANTERN", "LONGPHUNG", "lantern_dragon", "Đèn Rồng", "Rồng vàng quấn trụ son, vươn đầu về phía viên ngọc sáng.", C, 45000, 0, 2, 0.35),
    ("DECOR_PLANTER_SUNFLOWER", "DECOR", "PLANTER", "SUNGOLD", "planter_sunflower", "Thùng Hướng Dương", "Nửa thùng gỗ trồng năm cây hướng dương.", C, 2000, 0, 4, 0.4),
    ("DECOR_PLANTER_BLOSSOM", "DECOR", "PLANTER", "BLOSSOM", "planter_blossom", "Bonsai Anh Đào", "Chậu bonsai anh đào trên kỷ gỗ.", C, 5000, 0, 4, 0.35),
    ("DECOR_PLANTER_QUAT", "DECOR", "PLANTER", "TET", "planter_quat", "Cây Quất Tết", "Cây quất sai quả trong chậu men thắt nơ đỏ.", C, 7000, 0, 3, 0.35),
    ("DECOR_PLANTER_LOTUS", "DECOR", "PLANTER", "TET", "planter_lotus", "Chậu Sen Lớn", "Chậu men lam lớn với sen hồng, đặt giữa mấy viên đá.", C, 12000, 0, 3, 0.5),
    ("DECOR_PLANTER_FROST", "DECOR", "PLANTER", "FROST", "planter_frost", "Bình Hoa Băng", "Bình đá cắm những đóa hoa băng nhụy sáng.", C, 16000, 0, 3, 0.35),
    ("DECOR_BENCH_HARVEST", "DECOR", "BENCH", "AMBER", "bench_harvest", "Ghế Rơm Mùa Gặt", "Ghế xếp bằng kiện rơm trải chăn, bên bí ngô và thùng táo.", C, 4000, 0, 2, 0.7),
    ("DECOR_BENCH_SWING", "DECOR", "BENCH", "SUNGOLD", "bench_swing", "Xích Đu Hiên Hè", "Xích đu gỗ có đệm sọc và mái che.", C, 9000, 0, 2, 0.7),
    ("DECOR_BENCH_BLOSSOM", "DECOR", "BENCH", "BLOSSOM", "bench_blossom", "Ghế Vòm Hoa", "Ghế trắng dưới vòm hoa leo.", C, 12000, 0, 2, 0.6),
    ("DECOR_BENCH_TEA", "DECOR", "BENCH", "LONGPHUNG", "bench_tea", "Bàn Trà Sơn Son", "Bàn trà son đỏ với ấm chén và đôi đôn sứ men lam.", C, 20000, 0, 2, 0.7),
    ("DECOR_BENCH_CRYSTAL", "DECOR", "BENCH", "FROST", "bench_crystal", "Ghế Băng Pha Lê", "Ghế tạc từ băng trên chân pha lê, phủ đệm tuyết.", C, 24000, 0, 2, 0.6),
    ("DECOR_SIGN_FARM", "DECOR", "SIGN", "SUNGOLD", "sign_farm", "Biển Nông Trại Echo", "Biển gỗ khắc dấu đuôi cá voi Echo, dưới có bồn hoa.", C, 1500, 0, 1, 0.5),
    ("DECOR_SIGN_BUNTING", "DECOR", "SIGN", "AMBER", "sign_bunting", "Dây Cờ Hội Mùa", "Dây cờ tam giác giăng giữa hai cột, có bó lúa và bí ngô.", C, 5000, 0, 2, 0.7),
    ("DECOR_SIGN_CANDY", "DECOR", "SIGN", "LEHOI", "sign_candy", "Cột Kẹo Giáng Sinh", "Cột kẹo sọc treo vòng nguyệt quế và đèn nhỏ.", C, 8000, 0, 2, 0.4),
    ("DECOR_SIGN_SCARECROW", "DECOR", "SIGN", "LEHOI", "sign_scarecrow", "Bù Nhìn Đêm Hội", "Bù nhìn đầu bí ngô cười sáng đèn, tay xách đèn bí.", C, 10000, 0, 2, 0.5),
    ("DECOR_SIGN_NEU", "DECOR", "SIGN", "TET", "sign_neu", "Cây Nêu", "Cây nêu ngày Tết với vòng khánh, phướn đỏ và đèn lồng.", C, 15000, 0, 1, 0.4),
    ("DECOR_STATUE_WHALE", "DECOR", "STATUE", "CELESTIAL", "statue_whale", "Tượng Cá Voi Echo", "Tượng cá voi Echo bằng cẩm thạch trên bệ sóng viền sáng.", ACH_L, 0, 7, 1, 0.5),
    ("DECOR_STATUE_MEMORY", "DECOR", "STATUE", "CELESTIAL", "statue_memory", "Bia Ký Ức", "Tấm bia đá khắc những nét chữ phát sáng của các từ đã chăm.", ACH_L, 0, 14, 1, 0.45),
    ("DECOR_STATUE_RABBIT", "DECOR", "STATUE", "TRUNGTHU", "statue_rabbit", "Thỏ Ngọc", "Thỏ ngọc ngồi trong vành trăng khuyết giữa những vì sao.", C, 40000, 0, 1, 0.45),
    ("DECOR_STATUE_PHOENIX", "DECOR", "STATUE", "LONGPHUNG", "statue_phoenix", "Tượng Phượng Hoàng", "Phượng hoàng lửa xòe cánh trên bệ ngọc.", C, 110000, 0, 1, 0.5),
    ("DECOR_STATUE_DRAGON", "DECOR", "STATUE", "LONGPHUNG", "statue_dragon", "Tượng Kim Long", "Rồng vàng cuộn mình trên bệ cẩm thạch, ngậm ngọc sáng.", C, 140000, 0, 1, 0.45),
]

# where a decoration may stand: rectangles of free ground chosen from the island layout (grid cells; anchors inside)
REGIONS = [
    # Every quarter-tile point of a region is free ground (no bed, field, fence, path, water, building, tree, grove) AND stays
    # visible: at most 20 % of a decoration standing there is covered by a sprite in front of it, in the worst case over the
    # five monument eras, every house family and level, every cosmetic plant and fully grown Memory Trees. (The Knowledge
    # Tree's crown hides most of the east meadow and the lawn east of the farm: those are deliberately not regions.)
    ("COTTAGE_GARDEN", "Vườn trước nhà", [14.5, 10.0, 15.25, 10.5]),
    ("EAST_MEADOW", "Đồng cỏ phía Đông", [18.25, 9.75, 19.5, 10.5]),
    ("EAST_CLIFF", "Mỏm đá phía Đông", [21.5, 10.75, 22.5, 11.25]),
    ("POND_BANK", "Bờ ao", [8.5, 9.75, 11.25, 10.5]),
    ("NORTH_LAWN", "Bãi cỏ phía Bắc", [7.75, 6.5, 9.0, 7.25]),
    ("POND_MEADOW", "Bãi cỏ giữa ao và nông trại", [4.5, 14.5, 9.5, 15.0]),
    ("WEST_SHORE", "Mỏm cỏ phía Tây", [1.25, 10.25, 2.75, 10.75]),
    ("SOUTH_SHORE", "Bãi cỏ phía Nam", [6.25, 25.0, 13.25, 25.75]),
    ("SOUTH_EAST_SHORE", "Bờ Đông Nam", [16.0, 24.75, 20.0, 25.25]),
    ("SANCTUARY_TERRACE", "Thềm cỏ Cây Tri Thức", [21.75, 21.75, 22.75, 22.75]),
]
CONFIG = {"maxPlaced": 30, "snap": 0.25, "regions": [{"code": c, "nameVi": n, "rect": r} for c, n, r in REGIONS]}


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


def main():
    skins = [dict(code=a.upper(), artKey=a, cropCode=crop, collection=col, nameVi=n, descriptionVi=d, unlockKind=u, coinPrice=p, masteryTier=mt,
                  learningDays=ld, sortOrder=100 + i) for i, (a, crop, col, n, d, u, p, mt, ld) in enumerate(SKINS)]
    cos = [dict(code=c, category=cat, family=fam, collection=col, artKey=a, nameVi=n, descriptionVi=d, unlockKind=u, coinPrice=p, requirement=r,
                maxOwned=mx, footprint=fp, sortOrder=i + 1) for i, (c, cat, fam, col, a, n, d, u, p, r, mx, fp) in enumerate(COSMETICS)]
    cat = dict(collections=[dict(code=c, nameVi=n, descriptionVi=d, sortOrder=i + 1) for i, (c, n, d) in enumerate(COLLECTIONS)], skins=skins,
               cosmetics=cos, config=CONFIG)
    for row in skins + cos:
        assert len(row["nameVi"]) <= 80 and len(row["descriptionVi"]) <= 240 and len(row["code"]) <= 40, row["code"]
        assert (row["unlockKind"] == "COIN") == (row["coinPrice"] > 0), row["code"]
        assert row["collection"] in {c[0] for c in COLLECTIONS}, row["code"]
    assert len({r["code"] for r in skins}) == 50 and len({r["code"] for r in cos}) == len(cos)
    os.makedirs(os.path.dirname(JSON_OUT), exist_ok=True)
    with open(JSON_OUT, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(cat, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    template = open(os.path.join(HERE, "V86_template.sql"), encoding="utf-8").read()
    col_rows = ",\n".join(f"    ({q(c['code'])}, {q(c['nameVi'])}, {q(c['descriptionVi'])}, {c['sortOrder']})" for c in cat["collections"])
    skin_rows = ",\n".join(
        f"    ({q(s['code'])}, {q(s['cropCode'])}, {q(s['nameVi'])}, {q(s['descriptionVi'])}, {q(s['unlockKind'])}, {s['coinPrice']}, "
        f"{s['masteryTier']}, {s['learningDays']}, {q(s['artKey'])}, {s['sortOrder']}, {q(s['collection'])})" for s in skins)
    cos_rows = ",\n".join(
        f"    ({q(c['code'])}, {q(c['category'])}, {q(c['family'])}, {q(c['collection'])}, {q(c['nameVi'])}, {q(c['descriptionVi'])}, {q(c['artKey'])}, "
        f"{q(c['unlockKind'])}, {c['coinPrice']}, {c['requirement']}, {c['maxOwned']}, {c['footprint']}, {c['sortOrder']})" for c in cos)
    sql = (template.replace("/*COLLECTION_ROWS*/", col_rows).replace("/*SKIN_ROWS*/", skin_rows).replace("/*COSMETIC_ROWS*/", cos_rows)
           .replace("/*CONFIG_JSON*/", json.dumps(CONFIG, ensure_ascii=False, separators=(",", ":")).replace("'", "''")))
    with open(SQL_OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(sql)
    coin = [c for c in cos if c["unlockKind"] == "COIN"]
    print("collections", len(COLLECTIONS), "skins", len(skins), "cosmetics", len(cos))
    print("coin skins total", sum(s["coinPrice"] for s in skins), "coin cosmetics (one each)", sum(c["coinPrice"] for c in coin),
          "all units", sum(c["coinPrice"] * c["maxOwned"] for c in coin))


main()
