import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import VideoList from '../components/VideoList';
import { api } from '../api';
import { stopAllPlayers } from '../utils/playerManager';

export default function Search({ sources, selectedSearchSources, searchSourceMode, searchTrigger, setToastMessage }) {
  const { keyword } = useParams();
  const location = useLocation();
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchProgress, setSearchProgress] = useState("搜索 0/0 个源...");
  const navigate = useNavigate();
  const searchAbortController = useRef(null);
  const hasSearchedRef = useRef(false);
  const lastSearchTriggerRef = useRef(searchTrigger);
  const isSearchingRef = useRef(false);
  const searchCacheRef = useRef(new Map());
  const [sourcePageMap, setSourcePageMap] = useState({});
  const [pagingLoadingMap, setPagingLoadingMap] = useState({});

  // 添加状态来跟踪上一次的搜索条件
  const [previousSearch, setPreviousSearch] = useState({
    keyword: keyword,
    selectedSources: [...selectedSearchSources],
    sourceMode: searchSourceMode
  });

  // 处理搜索条件变化的逻辑
  useEffect(() => {
    if (keyword && sources.length > 0) {
      // 检查是否是从播放页返回
      if (location.state && location.state.fromPlayer && location.state.searchResults && location.state.searchKeyword === keyword) {
        // 使用从播放页返回时带回来的搜索结果
        const normalizedResults = (location.state.searchResults || []).map((group) => ({
          ...group,
          page: Number(group.page) || 1,
          totalPages: Number(group.totalPages || group.pagecount) || 1
        }));
        const pageMap = normalizedResults.reduce((acc, group) => {
          if (group?.source?.key) {
            acc[group.source.key] = Number(group.page) || 1;
          }
          return acc;
        }, {});
        setVideos(normalizedResults);
        setSourcePageMap(pageMap);
        setLoading(false);
        hasSearchedRef.current = true;

        // 更新上一次搜索条件
        setPreviousSearch({
          keyword: keyword,
          selectedSources: [...selectedSearchSources],
          sourceMode: searchSourceMode
        });

        isSearchingRef.current = false;
      } else {
        // 不是从播放页返回，只在关键词变化或首次加载时执行搜索
        const searchConditionsChanged = (
          keyword !== previousSearch.keyword
        );

        if (searchConditionsChanged || !hasSearchedRef.current) {
          // 关键词变化或初始加载，执行新搜索
          fetchMultiSourceSearch(keyword);
        }
      }
    } else if (!keyword) {
      setLoading(false);
    }

    return () => {
      if (searchAbortController.current) {
        searchAbortController.current.abort();
      }
      searchCacheRef.current.clear();
    };
  }, [keyword, sources, location.state]);

  // 单独处理搜索触发的逻辑
  useEffect(() => {
    if (searchTrigger === lastSearchTriggerRef.current || !keyword || sources.length === 0) return;

    // 检查搜索条件是否真正变化
    const searchConditionsChanged = (
      keyword !== previousSearch.keyword ||
      selectedSearchSources.length !== previousSearch.selectedSources.length ||
      selectedSearchSources.some(source => !previousSearch.selectedSources.includes(source)) ||
      searchSourceMode !== previousSearch.sourceMode
    );

    // 检查搜索状态
    const isSearchInProgress = isSearchingRef.current;

    if (searchConditionsChanged || !isSearchInProgress) {
      // 如果搜索条件变化，或者没有搜索在进行中，执行新搜索
      fetchMultiSourceSearch(keyword);
    }

    // 更新最后一次触发的搜索值
    lastSearchTriggerRef.current = searchTrigger;
  }, [searchTrigger, keyword, sources, selectedSearchSources, searchSourceMode]);



  const getCacheKey = (kw, sourceKey, page) => `${kw}::${sourceKey}::${page}`;

  const fetchSourcePage = async ({
    source,
    kw,
    page,
    signal,
    useCache = true
  }) => {
    const pageNum = Number(page) || 1;
    const cacheKey = getCacheKey(kw, source.key, pageNum);
    const cached = searchCacheRef.current.get(cacheKey);

    if (useCache && cached) {
      return cached;
    }

    const data = await api.searchVideos(source.key, kw, signal, pageNum);
    const totalPages = Number(data?.pagecount) || 1;
    const mapped = {
      source,
      page: Number(data?.page) || pageNum,
      totalPages,
      total: Number(data?.total) || 0,
      list: (data?.list || []).map(v => ({
        ...v,
        sourceName: source.name,
        sourceDesc: source.desc,
        sourceKey: source.key,
        uniqueId: `${source.key}_${v.vod_id}`
      }))
    };

    searchCacheRef.current.set(cacheKey, mapped);

    return mapped;
  };

  const fetchMultiSourceSearch = async (kw) => {
    // 设置搜索状态为进行中
    isSearchingRef.current = true;

    // 取消之前的搜索请求
    if (searchAbortController.current) {
      searchAbortController.current.abort();
    }

    // 创建新的AbortController
    const currentAbortController = new AbortController();
    searchAbortController.current = currentAbortController;
    searchCacheRef.current.clear();

    // 更新上一次搜索条件
    setPreviousSearch({
      keyword: kw,
      selectedSources: [...selectedSearchSources],
      sourceMode: searchSourceMode
    });

    // 根据搜索源模式过滤需要搜索的源（只搜索显式启用的源）
    const enabledSources = sources.filter(source => source.enabled === true);
    const sourcesToSearch = searchSourceMode === 'selected' && selectedSearchSources.length > 0
      ? enabledSources.filter(source => selectedSearchSources.includes(source.key))
      : enabledSources;


    // 初始化已完成搜索的源计数
    let completed = 0;

    // 首先更新状态，确保UI立即反映搜索开始
    setLoading(true);
    setVideos([]);
    setSourcePageMap({});
    setPagingLoadingMap({});
    setSearchProgress(`搜索 0/${sourcesToSearch.length} 个源...`);

    // 强制UI更新，确保搜索进度界面显示出来
    await new Promise(resolve => requestAnimationFrame(resolve)); // 使用requestAnimationFrame确保UI更新

    try {
      // 使用局部completed变量来跟踪当前搜索的进度
      const localCompleted = { count: 0 };

      const promises = sourcesToSearch.map(async (source) => {
        try {
          // 直接使用API请求，不设置前端超时，由后端接口控制
          const result = await fetchSourcePage({
            source,
            kw,
            page: 1,
            signal: currentAbortController.signal
          });

          localCompleted.count++;
          // 只有当当前搜索控制器仍然是活跃的时，才更新进度
          if (searchAbortController.current === currentAbortController) {
            setSearchProgress(`搜索 ${localCompleted.count}/${sourcesToSearch.length} 个源...`);
          }

          return result;
        } catch (err) {
          console.error(`搜索 ${source.name} 失败:`, err);
          localCompleted.count++;
          // 只有当当前搜索控制器仍然是活跃的时，才更新进度
          if (searchAbortController.current === currentAbortController) {
            setSearchProgress(`搜索 ${localCompleted.count}/${sourcesToSearch.length} 个源...`);
          }
          return { source, list: [] };
        }
      });

      // 使用Promise.allSettled而不是Promise.all，确保即使某些请求失败，也能收集所有结果
      const results = await Promise.allSettled(promises);
      // 只保留成功的结果
      const successfulResults = results
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value);
      setVideos(successfulResults);
      const pageMap = successfulResults.reduce((acc, group) => {
        if (group?.source?.key) {
          acc[group.source.key] = Number(group.page) || 1;
        }
        return acc;
      }, {});
      setSourcePageMap(pageMap);
      hasSearchedRef.current = true;
    } catch (err) {
      console.error('搜索失败:', err);
    } finally {
      // 只有当前搜索请求仍然是活跃的（没有被新请求替换），才更新loading状态
      if (searchAbortController.current === currentAbortController) {
        setLoading(false);
        // 设置搜索状态为已完成
        isSearchingRef.current = false;
      }
    }
  };

  const handleSourcePageChange = async (source, targetPage) => {
    const safeTargetPage = Number(targetPage) || 1;
    const currentPage = Number(sourcePageMap[source.key]) || 1;
    if (safeTargetPage === currentPage) return;

    const currentGroup = videos.find(group => group?.source?.key === source.key);
    const totalPages = Number(currentGroup?.totalPages) || 1;
    if (safeTargetPage < 1 || safeTargetPage > totalPages) return;
    if (!searchAbortController.current) return;

    setPagingLoadingMap(prev => ({ ...prev, [source.key]: true }));

    try {
      const nextGroup = await fetchSourcePage({
        source,
        kw: keyword,
        page: safeTargetPage,
        signal: searchAbortController.current.signal
      });

      setVideos(prev => prev.map(group => (
        group?.source?.key === source.key ? nextGroup : group
      )));
      setSourcePageMap(prev => ({ ...prev, [source.key]: safeTargetPage }));
    } catch (err) {
      console.error(`切换 ${source.name} 页码失败:`, err);
    } finally {
      setPagingLoadingMap(prev => ({ ...prev, [source.key]: false }));
    }
  };

  const handleVideoClick = (v) => {
    // 如果没有播放地址，则提示无法播放
    if (!v.vod_play_url || !String(v.vod_play_url).trim()) {
      setToastMessage && setToastMessage("此视频暂无法播放");
      return;
    }

    stopAllPlayers();
    // Prepare recommendation list from search results (filtering out clicked video)
    let recommendations = [];
    if (Array.isArray(videos)) {
      recommendations = videos.map(sourceGroup => ({
        ...sourceGroup,
        list: sourceGroup.list?.filter(video => video.uniqueId !== v.uniqueId) || []
      })).filter(sourceGroup => sourceGroup.list.length > 0);
    }

    // 导航到播放页时，将当前搜索结果和关键词存入state
    navigate(`/play/${v.sourceKey}/${v.vod_id}`, {
      state: {
        video: v,
        recommendations,
        searchResults: videos, // 存储当前搜索结果
        searchKeyword: keyword // 存储当前搜索关键词
      }
    });
  };

  return (
    <>
      <div className="flex items-center gap-4 mb-6 animate-fade-in">
        <Link
          to="/"
          className="flex items-center justify-center w-8 h-8 text-slate-400 hover:text-white hover:bg-slate-800 rounded-full transition-all"
          aria-label="返回列表"
        >
          <ChevronLeft size={24} />
        </Link>
        <div className="h-6 w-px bg-white/10"></div>
        <h2 className="text-xl font-bold text-white truncate">
          搜索 <span className="text-blue-400">{keyword}</span> 的结果
        </h2>
      </div>

      <VideoList
        videos={videos}
        loading={loading}
        view="search_results"
        searchProgress={searchProgress}
        handleVideoClick={handleVideoClick}
        sourcePageMap={sourcePageMap}
        pagingLoadingMap={pagingLoadingMap}
        onSourcePageChange={handleSourcePageChange}
      />
    </>
  );
}
