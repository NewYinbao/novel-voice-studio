const datasetTag = 'AISHELL-3';
const licenseTag = 'Apache-2.0';

function preset({ key, speakerId, name, category, variant, ageGroup, gender, accent, transcript, files }) {
  const marker = `${datasetTag}/${speakerId}`;
  const tags = [category, variant, gender, ageGroup, accent, '预置音色', datasetTag, licenseTag, marker];
  return { key, speakerId, marker, name, category, variant, ageGroup, gender, accent, transcript, tags, files };
}

// AISHELL-3 年龄分组：B=14–25，C=26–40，D=>41。
// “年长教师感 / 中年 / 少女感 / 少年感”是有声书选角标签，不是说话人职业或精确年龄声明。
export const OPEN_SOURCE_VOICE_PRESETS = [
  preset({
    key: 'senior-teacher-male-north', speakerId: 'SSB0434',
    name: '年长教师感 · 男声', category: '年长教师感', variant: '男声 · 北方',
    ageGroup: 'D组 >41', gender: '男声', accent: '北方口音',
    transcript: '盛苑琴行。播放十一年。明天会更好。',
    files: [
      ['test/wav/SSB0434/SSB04340183.wav', '16867942a13b0bab5920904f25ddaf4a29a6706c2e194218d056c73e88998d8e'],
      ['test/wav/SSB0434/SSB04340423.wav', '60ba629de41d0272fe18ede197364533d7abd96f036d39110c438e01c02ff2f9'],
      ['test/wav/SSB0434/SSB04340361.wav', '9d05a37293174b64c5fc4232aaf5a730414e3bc3fe463c6192b2d1eefca57b87']
    ]
  }),
  preset({
    key: 'senior-teacher-female-north-1', speakerId: 'SSB0354',
    name: '年长教师感 · 女声 01', category: '年长教师感', variant: '女声 01 · 北方',
    ageGroup: 'D组 >41', gender: '女声', accent: '北方口音',
    transcript: '你还好吗？嗯，我没问题，谢谢。',
    files: [['test/wav/SSB0354/SSB03540124.wav', '274fbe2bffdf5b799bac5ba03faad7f1025b4044a5508355fcee3199d44714d8']]
  }),
  preset({
    key: 'senior-teacher-female-north-2', speakerId: 'SSB0737',
    name: '年长教师感 · 女声 02', category: '年长教师感', variant: '女声 02 · 北方',
    ageGroup: 'D组 >41', gender: '女声', accent: '北方口音',
    transcript: '又被电梯外门夹住头和身子。',
    files: [['test/wav/SSB0737/SSB07370462.wav', '10dedb0d2d0db6161680f32273f506702a0886e7968ffd51ca165553a4c3b6fc']]
  }),
  preset({
    key: 'middle-male-north-1', speakerId: 'SSB0710',
    name: '中年男声 · 北方 01', category: '中年男声', variant: '北方 01',
    ageGroup: 'C组 26–40', gender: '男声', accent: '北方口音',
    transcript: '九十三。九十七。还有没有人？',
    files: [
      ['test/wav/SSB0710/SSB07100296.wav', 'd9263d60f4a9e23e30de20e850bee347c9ac0427b0e27c6acc09c16f4b62d22a'],
      ['test/wav/SSB0710/SSB07100430.wav', 'b584a2c53a9d1e7e1ddbf26a27a5874e4fb69d900ea610693710aaf2d5f01b00'],
      ['test/wav/SSB0710/SSB07100231.wav', '4bf5e394c51666398e8354b8f2538b8a7bdc175b9cebae16aa2295a1ac60278b']
    ]
  }),
  preset({
    key: 'middle-male-north-2', speakerId: 'SSB0261',
    name: '中年男声 · 北方 02', category: '中年男声', variant: '北方 02',
    ageGroup: 'C组 26–40', gender: '男声', accent: '北方口音',
    transcript: '寂寞红。十一年。药别停。',
    files: [
      ['test/wav/SSB0261/SSB02610195.wav', '6c6662578397a13e1094b3f545a3c76c1c7edac53dff60057fcf3315c56ac26b'],
      ['test/wav/SSB0261/SSB02610236.wav', 'c162aaf765b3fc916586751ab5f05745a17e60780022c118e5585f26c7cec6ec'],
      ['test/wav/SSB0261/SSB02610360.wav', 'a9d3aa2c66cd30b395b389f5f65d2de616418fcca0dcc39ee9dbdf415bdc4efc']
    ]
  }),
  preset({
    key: 'middle-male-north-3', speakerId: 'SSB0407',
    name: '中年男声 · 北方 03', category: '中年男声', variant: '北方 03',
    ageGroup: 'C组 26–40', gender: '男声', accent: '北方口音',
    transcript: '柯林这样的人。七十二点四。她仍在接近。',
    files: [
      ['test/wav/SSB0407/SSB04070281.wav', '67050c1e313cecd626faa536f61c1cb08eb89e6167c1825beaed97273dbe1e49'],
      ['test/wav/SSB0407/SSB04070322.wav', 'c0b623ebaafbd51d083ae30b2d59bee9ee2dfb633454bee0ed13d5c4abd1ba35'],
      ['test/wav/SSB0407/SSB04070313.wav', 'e7859128346dd60d59512368433e7739484d3cffc271b503236ff8ce55b386c0']
    ]
  }),
  preset({
    key: 'middle-female-north-1', speakerId: 'SSB0534',
    name: '中年女声 · 北方 01', category: '中年女声', variant: '北方 01',
    ageGroup: 'C组 26–40', gender: '女声', accent: '北方口音',
    transcript: '至上励合。你没搞错吧？干衣机。',
    files: [
      ['test/wav/SSB0534/SSB05340090.wav', '8b3a0ae29302f51daf4c9141d92ad2d279b301f675e3da405a30ffcc826bba6b'],
      ['test/wav/SSB0534/SSB05340348.wav', '374bcc25afb1b1327b85f04f894c6df39c8c55e7266cd216e05ea42897f6de8c'],
      ['test/wav/SSB0534/SSB05340225.wav', 'b1251de88e0dda69070c67ff3063ae0dd84538112013c91adc9aa8bc0306919e']
    ]
  }),
  preset({
    key: 'middle-female-south', speakerId: 'SSB0197',
    name: '中年女声 · 南方', category: '中年女声', variant: '南方',
    ageGroup: 'C组 26–40', gender: '女声', accent: '南方口音',
    transcript: '北科大展示羽毛球机器人，与新生进行比赛。',
    files: [['test/wav/SSB0197/SSB01970030.wav', '0b7132e8f90acbd4dc0c50b45efc8f063498d78fb0fbfbfef4f9f911c265ae78']]
  }),
  preset({
    key: 'middle-female-north-2', speakerId: 'SSB0341',
    name: '中年女声 · 北方 02', category: '中年女声', variant: '北方 02',
    ageGroup: 'C组 26–40', gender: '女声', accent: '北方口音',
    transcript: '我们今年是第一次来到科纳，目睹这项体育盛事。',
    files: [['test/wav/SSB0341/SSB03410377.wav', '4949b8d900a08c842ec7fcc7df85810e0c6e864a4e330a1f7792b2edf182ede0']]
  }),
  preset({
    key: 'young-female-north', speakerId: 'SSB0700',
    name: '少女感 · 北方', category: '少女感', variant: '北方',
    ageGroup: 'B组 14–25', gender: '女声', accent: '北方口音',
    transcript: '副省长何报翔立即要求省旅游局督促张家界市一查到底。',
    files: [['test/wav/SSB0700/SSB07000265.wav', '3636d16033370733d764f671642606216517b862f57d00e6fc1d9366bb072a08']]
  }),
  preset({
    key: 'young-female-south-1', speakerId: 'SSB0693',
    name: '少女感 · 南方 01', category: '少女感', variant: '南方 01',
    ageGroup: 'B组 14–25', gender: '女声', accent: '南方口音',
    transcript: '塘中的金鱼、草鱼、白鲢等不少长得奇形怪状。',
    files: [['test/wav/SSB0693/SSB06930018.wav', 'b5b24d3f9fec30d6569d6580887ddb1c0646a3669f4a4d68a0a02a9310e7ff7b']]
  }),
  preset({
    key: 'young-female-south-2', speakerId: 'SSB0149',
    name: '少女感 · 南方 02', category: '少女感', variant: '南方 02',
    ageGroup: 'B组 14–25', gender: '女声', accent: '南方口音',
    transcript: '这个全球首个搏击赛事平台，会将这民族精神最大化发扬。',
    files: [['test/wav/SSB0149/SSB01490015.wav', '139c1d719d8b1518ec74a058f1c6807dcffa26482efa46dbbfa9d5c7190a48f3']]
  }),
  preset({
    key: 'young-male-north-1', speakerId: 'SSB0073',
    name: '少年感 · 北方 01', category: '少年感', variant: '北方 01',
    ageGroup: 'B组 14–25', gender: '男声', accent: '北方口音',
    transcript: '在罗湖上班的向先生跑去东莞凤岗。',
    files: [['test/wav/SSB0073/SSB00730450.wav', '228ffa25f5df67136858061f0260cb8fa719179c00cb5166751256731aec367a']]
  }),
  preset({
    key: 'young-male-north-2', speakerId: 'SSB0535',
    name: '少年感 · 北方 02', category: '少年感', variant: '北方 02',
    ageGroup: 'B组 14–25', gender: '男声', accent: '北方口音',
    transcript: '例如，一些假设性的前提条件常常被忽略。',
    files: [['test/wav/SSB0535/SSB05350209.wav', '5ee48ee36162a3df4269da03641a33c0753573cbffc0e77ae5b388fe03a4b9e3']]
  }),
  preset({
    key: 'young-male-south', speakerId: 'SSB0631',
    name: '少年感 · 南方', category: '少年感', variant: '南方',
    ageGroup: 'B组 14–25', gender: '男声', accent: '南方口音',
    transcript: '将会使公司有较多灵活性，及时作出投资决定。',
    files: [['test/wav/SSB0631/SSB06310207.wav', '2b94b3718bf942973d42fb4d452e386080aa3dff647988c8e4ab3fa92fd7093c']]
  })
];

export const VOICE_PRESET_CATEGORIES = ['年长教师感', '中年男声', '中年女声', '少女感', '少年感'];
